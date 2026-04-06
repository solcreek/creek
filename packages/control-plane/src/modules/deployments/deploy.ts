import type { Env } from "../../types.js";
import type { WfPBinding } from "../resources/service.js";

/** Map file extension to CF Workers module type */
function workerModuleType(name: string): string {
  if (name.endsWith(".mjs") || name.endsWith(".js")) return "application/javascript+module";
  if (name.endsWith(".cjs")) return "application/javascript";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".txt") || name.endsWith(".html")) return "text/plain";
  return "application/octet-stream";
}

export function shortDeployId(deploymentId: string): string {
  return deploymentId.slice(0, 8);
}

export function sanitizeBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 27);
}

// --- WfP Static Assets API ---

interface AssetManifestEntry {
  hash: string;
  size: number;
}

interface AssetUploadSessionResponse {
  jwt: string;
  buckets: string[][];
}

interface AssetUploadResponse {
  jwt: string;
}

async function cfApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
): Promise<any> {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken ?? env.CLOUDFLARE_API_TOKEN}`,
  };

  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }

  const res = await fetch(url, init);
  const json = await res.json() as any;

  if (!json.success && json.errors?.length) {
    throw new Error(`CF API error: ${JSON.stringify(json.errors)}`);
  }

  return json.result;
}

/** Compute a 32-char hex hash for an asset file, salted with team ID for isolation */
async function hashAsset(content: ArrayBuffer, salt: string): Promise<string> {
  const saltBytes = new TextEncoder().encode(salt);
  const combined = new Uint8Array(saltBytes.length + content.byteLength);
  combined.set(saltBytes, 0);
  combined.set(new Uint8Array(content), saltBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 32);
}

/** Step 1: Create an asset upload session */
async function createAssetUploadSession(
  env: Env,
  scriptName: string,
  manifest: Record<string, AssetManifestEntry>,
): Promise<AssetUploadSessionResponse> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}/assets-upload-session`;
  return cfApi(env, "POST", path, { manifest });
}

/** Step 2: Upload asset files using the session JWT */
async function uploadAssetFiles(
  env: Env,
  uploadJwt: string,
  buckets: string[][],
  assets: Record<string, ArrayBuffer>,
  hashToPath: Record<string, string>,
): Promise<string> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/assets/upload?base64=true`;
  let completionJwt = "";

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const filePath = hashToPath[hash];
      if (!filePath || !assets[filePath]) continue;
      const b64 = arrayBufferToBase64(assets[filePath]);
      form.append(hash, b64);
    }

    const result = await cfApi(env, "POST", path, form, uploadJwt) as AssetUploadResponse;
    completionJwt = result.jwt ?? completionJwt;
  }

  return completionJwt;
}

/** Step 3: Deploy worker script with assets completion JWT, tags, and bindings */
/** Durable Object bindings required by @opennextjs/cloudflare for ISR/cache */
const NEXTJS_DO_BINDINGS: WfPBinding[] = [
  { type: "durable_object_namespace", name: "NEXT_CACHE_DO_QUEUE", class_name: "DOQueueHandler" },
  { type: "durable_object_namespace", name: "NEXT_TAG_CACHE_DO_SHARDED", class_name: "DOShardedTagCache" },
  { type: "durable_object_namespace", name: "NEXT_CACHE_DO_BUCKET_PURGE", class_name: "BucketCachePurge" },
] as any[];

/**
 * DO migrations for Next.js SSR.
 * First deploy uses new_tag + new_sqlite_classes.
 * Subsequent deploys just reference the tag (no new_sqlite_classes).
 */
const NEXTJS_DO_MIGRATION_TAG = "v1";

async function deployScriptWithAssets(
  env: Env,
  scriptName: string,
  workerFiles: File[],
  mainModule: string,
  completionJwt: string,
  tags: string[],
  bindings: WfPBinding[],
  assetsConfig?: Record<string, unknown>,
  compatibilityDate?: string,
  compatibilityFlags?: string[],
  framework?: string | null,
): Promise<void> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}`;

  // Auto-inject Next.js DO bindings for ISR/cache support
  const allBindings = framework === "nextjs"
    ? [...bindings, ...NEXTJS_DO_BINDINGS]
    : bindings;

  // Next.js (via @opennextjs/cloudflare) requires nodejs_compat_v2 for
  // full Node.js module support (fs, http, worker_threads shims, etc.)
  const defaultFlags = framework === "nextjs"
    ? ["nodejs_compat_v2"]
    : ["nodejs_compat"];

  const metadata: Record<string, unknown> = {
    main_module: mainModule,
    compatibility_date: compatibilityDate ?? "2025-03-14",
    compatibility_flags: compatibilityFlags?.length ? compatibilityFlags : defaultFlags,
    tags,
    bindings: allBindings,
    assets: {
      jwt: completionJwt,
      config: assetsConfig ?? {},
    },
  };

  // DO migrations for Next.js SSR.
  // Check if this script already has the migration applied (migration_tag == v1).
  // If not, send full migration. If yes, just set the tag.
  if (framework === "nextjs") {
    // For WfP scripts, we can't easily query the current migration_tag.
    // Use a simple approach: always send migrations with new_tag.
    // CF will reject if tag already matches, so we catch and retry with tag-only.
    metadata.migrations = {
      new_tag: NEXTJS_DO_MIGRATION_TAG,
      new_sqlite_classes: ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"],
    };
  }

  async function attemptDeploy(meta: Record<string, unknown>): Promise<void> {
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(meta)], { type: "application/json" }),
    );
    for (const file of workerFiles) {
      form.append(file.name, file);
    }
    await cfApi(env, "PUT", path, form);
  }

  try {
    await attemptDeploy(metadata);
  } catch (err: any) {
    // Handle DO migration tag mismatch — retry with matching old_tag
    if (framework === "nextjs" && err?.message?.includes("migration tag precondition failed")) {
      // Script already has the migration applied. Remove migrations, just set tag.
      delete metadata.migrations;
      metadata.migration_tag = NEXTJS_DO_MIGRATION_TAG;
      await attemptDeploy(metadata);
    } else {
      throw err;
    }
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- Public deploy functions ---

export interface DeployAssetsInput {
  clientAssets: Record<string, ArrayBuffer>;
  serverFiles?: Record<string, ArrayBuffer>;
  renderMode: "spa" | "ssr" | "worker";
  teamId: string;
  teamSlug: string;
  projectSlug: string;
  plan: string;
  bindings: WfPBinding[];
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** Framework name — used to auto-inject DO bindings (e.g., "nextjs" → ISR cache DOs) */
  framework?: string | null;
}

/**
 * Deploy a project using WfP Static Assets API.
 * Works for both SPA and SSR frameworks.
 */
export async function deployWithAssets(
  env: Env,
  projectSlug: string,
  teamSlug: string,
  deploymentId: string,
  input: DeployAssetsInput,
  branch?: string | null,
  productionBranch?: string,
): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    return; // Local dev mode
  }

  const shortId = shortDeployId(deploymentId);

  // Build asset manifest with team-salted hashes
  const manifest: Record<string, AssetManifestEntry> = {};
  const hashToPath: Record<string, string> = {};

  for (const [filePath, content] of Object.entries(input.clientAssets)) {
    const hash = await hashAsset(content, input.teamId);
    const key = filePath.startsWith("/") ? filePath : `/${filePath}`;
    manifest[key] = { hash, size: content.byteLength };
    hashToPath[hash] = filePath;
  }

  // Prepare worker files
  let workerFiles: File[];
  let mainModule: string;
  let assetsConfig: Record<string, unknown> | undefined;

  if ((input.renderMode === "ssr" || input.renderMode === "worker") && input.serverFiles) {
    // SSR: upload framework's server files as worker modules with correct MIME types
    workerFiles = Object.entries(input.serverFiles).map(
      ([name, content]) =>
        new File([content], name, { type: workerModuleType(name) }),
    );
    // Find main module (usually worker.js, server.js, or index.js)
    mainModule = Object.keys(input.serverFiles).find(
      (n) => n === "worker.js" || n === "server.js" || n === "index.js" || n === "index.mjs",
    ) ?? Object.keys(input.serverFiles)[0];
  } else {
    // SPA: worker with embedded index.html for client-side routing fallback
    // WfP Static Assets doesn't support not_found_handling, so the worker handles it
    // We embed index.html directly in the worker to avoid recursive fetch issues
    const indexHtmlContent = input.clientAssets["/index.html"] ?? input.clientAssets["index.html"];
    const indexHtml = indexHtmlContent
      ? new TextDecoder().decode(new Uint8Array(indexHtmlContent))
      : "<html><body>Not found</body></html>";

    const spaWorker = `
const INDEX_HTML = ${JSON.stringify(indexHtml)};

export default {
  async fetch(request, env) {
    try {
      const res = await env.ASSETS.fetch(request);
      if (res.ok || res.status === 304) return res;
    } catch {}
    // SPA fallback — return embedded index.html for client-side routing
    return new Response(INDEX_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
};`;
    mainModule = "worker.mjs";
    workerFiles = [
      new File([spaWorker], mainModule, {
        type: "application/javascript+module",
      }),
    ];
    assetsConfig = {};
  }

  // Build script deployments with tags
  interface ScriptDeploy {
    name: string;
    type: "production" | "preview" | "branch";
  }

  const scripts: ScriptDeploy[] = [];

  // Always create deployment preview (immutable)
  scripts.push({
    name: `${projectSlug}-${shortId}-${teamSlug}`,
    type: "preview",
  });

  // Branch preview (mutable)
  if (branch) {
    const sanitized = sanitizeBranch(branch);
    scripts.push({
      name: `${projectSlug}-git-${sanitized}-${teamSlug}`,
      type: "branch",
    });
  }

  // Production (mutable)
  if (!branch || (productionBranch && branch === productionBranch)) {
    scripts.push({
      name: `${projectSlug}-${teamSlug}`,
      type: "production",
    });
  }

  // Deploy to each script name with appropriate tags
  for (const script of scripts) {
    const tags = [
      `team:${input.teamSlug}`,
      `project:${input.projectSlug}`,
      `type:${script.type}`,
      `plan:${input.plan}`,
    ];

    // Step 1: Create upload session
    const session = await createAssetUploadSession(env, script.name, manifest);

    // Step 2: Upload files (only those needed — dedup handled by CF)
    let completionJwt = session.jwt;
    if (session.buckets && session.buckets.length > 0) {
      completionJwt = await uploadAssetFiles(
        env,
        session.jwt,
        session.buckets,
        input.clientAssets,
        hashToPath,
      );
    }

    // Step 3: Deploy worker with assets, tags, and per-tenant bindings
    await deployScriptWithAssets(
      env,
      script.name,
      workerFiles,
      mainModule,
      completionJwt,
      tags,
      input.bindings,
      assetsConfig,
      input.compatibilityDate,
      input.compatibilityFlags,
      input.framework,
    );
  }
}

// --- Legacy R2-based functions (kept for fallback / local dev) ---

export async function uploadAssetsToR2(
  env: Env,
  projectId: string,
  deploymentId: string,
  assets: Record<string, ArrayBuffer>,
): Promise<string[]> {
  const uploadedPaths: string[] = [];
  const prefix = `${projectId}/${deploymentId}`;

  for (const [path, data] of Object.entries(assets)) {
    const key = `${prefix}/${path}`;
    await env.ASSETS.put(key, data);
    uploadedPaths.push(path);
  }

  return uploadedPaths;
}

export function generateStaticWorkerScript(): string {
  return `
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
`;
}
