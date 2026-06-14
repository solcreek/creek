import type { DeployEnv, DeployAssetsInput, WfPBinding } from "./types.js";
import { cfApi } from "./cf-api.js";
import { hashAsset, createAssetUploadSession, uploadAssetFiles } from "./assets.js";
import { SPA_WORKER_SCRIPT } from "./spa-worker.js";

/**
 * Map file extension to Workers module type.
 * CF Workers API requires correct MIME types for each uploaded module.
 * Non-JS files (JSON, WASM, text) must use their specific types.
 */
function workerFileType(name: string): string {
  if (name.endsWith(".mjs") || name.endsWith(".js")) return "application/javascript+module";
  if (name.endsWith(".cjs")) return "application/javascript";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".txt") || name.endsWith(".map")) return "text/plain";
  if (name.endsWith(".html")) return "text/html";
  // Default: treat as binary data (safe for any file type)
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

// Durable Object bindings Next.js (via the Creek adapter / @opennextjs)
// needs for ISR + tag cache. The DO classes are bundled in the worker.
// Kept in sync with the production control-plane deploy path.
const NEXTJS_DO_BINDINGS: WfPBinding[] = [
  { type: "durable_object_namespace", name: "NEXT_CACHE_DO_QUEUE", class_name: "DOQueueHandler" },
  { type: "durable_object_namespace", name: "NEXT_TAG_CACHE_DO_SHARDED", class_name: "DOShardedTagCache" },
  { type: "durable_object_namespace", name: "NEXT_CACHE_DO_BUCKET_PURGE", class_name: "BucketCachePurge" },
] as WfPBinding[];

const NEXTJS_DO_MIGRATION_TAG = "v1";

/**
 * Step 3: Deploy worker script with assets completion JWT, tags, and bindings.
 */
export async function deployScriptWithAssets(
  env: DeployEnv,
  scriptName: string,
  workerFiles: File[],
  mainModule: string,
  completionJwt: string,
  tags: string[],
  bindings: WfPBinding[],
  assetsConfig?: Record<string, unknown>,
  cronSchedules?: string[],
  compatibilityDate?: string,
  compatibilityFlags?: string[],
  framework?: string | null,
): Promise<void> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}`;

  // Next.js (via the Creek adapter) emits a worker that statically imports
  // node:http etc. In Workers for Platforms node:http is served by
  // `nodejs_compat` (NOT `nodejs_compat_v2`, which does not provide it) and
  // only at a recent compatibility_date — empirically rejected at
  // 2025-03-14, accepted from ~2025-09 on. The Creek adapter builds the
  // bundle at 2026-03-28, so deploy at that date too. Without this, SSR
  // Next.js workers fail validation with "No such module node:http".
  // Also inject the DO bindings/migrations the adapter needs for ISR/tag
  // cache. Mirrors the production control-plane path for Next.js.
  const isNext = framework === "nextjs";
  const defaultDate = isNext ? "2026-03-28" : "2025-03-14";
  const defaultFlags = ["nodejs_compat"];
  const allBindings = isNext ? [...bindings, ...NEXTJS_DO_BINDINGS] : bindings;

  const metadata: Record<string, unknown> = {
    main_module: mainModule,
    // Prefer the bundle's declared compat date/flags — user bundles
    // can require newer Node API support (e.g. `@astrojs/cloudflare`
    // pulls in `node:fs` paths that only resolve on newer dates).
    // Fall back to a framework-aware Creek default when unset.
    compatibility_date: compatibilityDate ?? defaultDate,
    compatibility_flags: compatibilityFlags?.length ? compatibilityFlags : defaultFlags,
    tags,
    bindings: allBindings,
    assets: {
      jwt: completionJwt,
      config: assetsConfig ?? {},
    },
    // NOTE: tail_consumers is NOT set here. CF silently ignores
    // tail_consumers in the WfP script upload metadata (verified
    // 2026-04-13: deploys with the field accept it but no events
    // ever reach the named tail worker). The supported pattern for
    // WfP is to attach the tail consumer to the dispatch worker
    // itself — see packages/dispatch-worker/wrangler.toml. The
    // dispatch worker's tail_consumers automatically captures every
    // user worker dispatched through it.
  };

  // DO migrations for Next.js SSR. A sandbox script is always a fresh
  // name (unique sandboxId), so it's a first deploy → new_sqlite_classes.
  // On an existing script the tag precondition fails; retry tag-only.
  if (isNext) {
    metadata.migrations = {
      new_tag: NEXTJS_DO_MIGRATION_TAG,
      new_sqlite_classes: ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"],
    };
  }

  if (cronSchedules && cronSchedules.length > 0) {
    metadata.triggers = { crons: cronSchedules };
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
  } catch (err) {
    if (isNext && err instanceof Error && err.message.includes("migration tag precondition failed")) {
      delete metadata.migrations;
      metadata.migration_tag = NEXTJS_DO_MIGRATION_TAG;
      await attemptDeploy(metadata);
    } else {
      throw err;
    }
  }
}

/**
 * Build an SPA worker script with embedded index.html for fallback.
 * WfP Static Assets doesn't support not_found_handling, so the worker handles SPA routing.
 */
export function buildSpaWorker(indexHtmlContent: ArrayBuffer | undefined): {
  workerFiles: File[];
  mainModule: string;
} {
  const indexHtml = indexHtmlContent
    ? new TextDecoder().decode(new Uint8Array(indexHtmlContent))
    : "<html><body>Not found</body></html>";

  const script = SPA_WORKER_SCRIPT.replace("__INDEX_HTML__", JSON.stringify(indexHtml));

  return {
    mainModule: "worker.mjs",
    workerFiles: [
      new File([script], "worker.mjs", { type: "application/javascript+module" }),
    ],
  };
}

/**
 * Full deploy: hash assets → upload session → upload files → deploy script(s).
 * Used by both production control-plane and sandbox-api.
 */
export async function deployWithAssets(
  env: DeployEnv,
  projectSlug: string,
  teamSlug: string,
  deploymentId: string,
  input: DeployAssetsInput,
  branch?: string | null,
  productionBranch?: string,
  cronSchedules?: string[],
): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    return; // Local dev mode
  }

  const shortId = shortDeployId(deploymentId);

  // Build asset manifest with team-salted hashes
  const manifest: Record<string, { hash: string; size: number }> = {};
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
    workerFiles = Object.entries(input.serverFiles).map(
      ([name, content]) =>
        new File([content], name, { type: workerFileType(name) }),
    );
    // Prefer the framework's canonical entrypoint name. `entry.mjs` is
    // emitted by `@astrojs/cloudflare`; the others cover our older
    // SSR paths (Nuxt/SolidStart nitro, custom workers). Fallback to
    // the first file only if none match.
    mainModule = Object.keys(input.serverFiles).find(
      (n) =>
        n === "worker.js" ||
        n === "server.js" ||
        n === "index.js" ||
        n === "index.mjs" ||
        n === "entry.mjs",
    ) ?? Object.keys(input.serverFiles)[0];
  } else {
    const indexHtml = input.clientAssets["/index.html"] ?? input.clientAssets["index.html"];
    const spa = buildSpaWorker(indexHtml);
    workerFiles = spa.workerFiles;
    mainModule = spa.mainModule;
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

  // Deploy to each script name
  for (const script of scripts) {
    const tags = [
      `team:${input.teamSlug}`,
      `project:${input.projectSlug}`,
      `type:${script.type}`,
      `plan:${input.plan}`,
    ];

    const session = await createAssetUploadSession(env, script.name, manifest);

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
      isProduction ? cronSchedules : undefined,
      input.compatibilityDate,
      input.compatibilityFlags,
      input.framework,
    );
  }
}
