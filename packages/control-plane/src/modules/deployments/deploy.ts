import type { Env } from "../../types.js";
import type { WfPBinding } from "../resources/service.js";
// Single source of truth for the low-level WfP script deploy (upload metadata,
// migration-tag retry, observability enablement). Previously this file kept its
// own diverged copy — a fix to one (e.g. the observability settings PATCH)
// silently missed the other. deploy-job.msw.test.ts asserts the observability
// call so a future divergence fails CI.
import { deployScriptWithAssets } from "@solcreek/deploy-core";

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

  const buildForm = (bucket: string[]): FormData => {
    const form = new FormData();
    for (const hash of bucket) {
      const filePath = hashToPath[hash];
      if (!filePath || !assets[filePath]) continue;
      form.append(hash, arrayBufferToBase64(assets[filePath]));
    }
    return form;
  };

  // Upload buckets with bounded concurrency rather than one-at-a-time. A serial
  // loop over an asset-heavy app's buckets (tens of MB) is the bulk of a
  // multi-minute "deploying to edge" step. Each bucket POST is independent (all
  // use the same uploadJwt); Cloudflare returns the session completion JWT once
  // every file is received, so we keep the last non-empty jwt across responses.
  // Mirrors deploy-core's uploadAssetFiles — the two should be consolidated.
  const CONCURRENCY = 6;
  let completionJwt = "";
  let next = 0;
  async function worker(): Promise<void> {
    while (next < buckets.length) {
      const bucket = buckets[next++];
      const result = (await cfApi(env, "POST", path, buildForm(bucket), uploadJwt)) as AssetUploadResponse;
      if (result.jwt) completionJwt = result.jwt;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, buckets.length) }, () => worker()),
  );

  return completionJwt;
}

/**
 * Resolve the Worker compat date/flags for a deploy. The bundle is preferred
 * (the Creek adapter records the exact date/flags it built against in its
 * manifest, threaded through as compatibilityDate/Flags). When unset, fall
 * back to a framework-aware default.
 *
 * Next.js workers statically import node:http, whose SERVER modules are
 * served by the umbrella `nodejs_compat` flag (NOT `nodejs_compat_v2`) and
 * auto-enable only at compatibility_date >= 2025-09-01 (per Cloudflare's
 * Node.js docs). So the Next.js default uses nodejs_compat + the Creek
 * adapter's build date (2026-03-28); a 2025-03-14 default was rejected with
 * "No such module node:http".
 *
 * Exported for tests.
 */
export function resolveDeployCompat(
  framework: string | null | undefined,
  compatibilityDate?: string,
  compatibilityFlags?: string[],
): { compatibility_date: string; compatibility_flags: string[] } {
  const isNext = framework === "nextjs";
  return {
    compatibility_date: compatibilityDate ?? (isNext ? "2026-03-28" : "2025-03-14"),
    compatibility_flags: compatibilityFlags?.length ? compatibilityFlags : ["nodejs_compat"],
  };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Build the binary string in chunks via fromCharCode.apply instead of
  // appending one char at a time. Per-byte concatenation reallocates the
  // string on every byte and is pathologically slow for MB-sized assets (the
  // CPU half of a slow edge deploy); chunking makes it linear. 32KB keeps the
  // apply() argument count well under engine limits.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
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
  cronSchedules?: string[];
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
    // Only attach cron triggers to the production script (not preview/branch)
    const isProduction = script.name === `${projectSlug}-${teamSlug}`;
    await deployScriptWithAssets(
      env,
      script.name,
      workerFiles,
      mainModule,
      completionJwt,
      tags,
      input.bindings,
      assetsConfig,
      isProduction ? input.cronSchedules : undefined,
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
