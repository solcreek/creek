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
): Promise<void> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}`;

  const metadata: Record<string, unknown> = {
    main_module: mainModule,
    compatibility_date: "2025-03-14",
    compatibility_flags: ["nodejs_compat"],
    tags,
    bindings,
    assets: {
      jwt: completionJwt,
      config: assetsConfig ?? {},
    },
  };

  if (cronSchedules && cronSchedules.length > 0) {
    metadata.triggers = { crons: cronSchedules };
  }

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const file of workerFiles) {
    form.append(file.name, file);
  }

  await cfApi(env, "PUT", path, form);
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

  if (input.renderMode === "ssr" && input.serverFiles) {
    workerFiles = Object.entries(input.serverFiles).map(
      ([name, content]) =>
        new File([content], name, { type: workerFileType(name) }),
    );
    mainModule = Object.keys(input.serverFiles).find(
      (n) => n === "worker.js" || n === "server.js" || n === "index.js" || n === "index.mjs",
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
    );
  }
}
