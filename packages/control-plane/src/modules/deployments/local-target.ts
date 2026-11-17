import type { DeployTarget } from "./target.js";
import { uploadAssetsToR2 } from "./deploy.js";

/**
 * Whether an asset name stays inside the deployment's prefix once the local
 * bucket has turned it into a file path. Names come from the uploaded bundle,
 * so they are checked rather than trusted: `../../other/dep/index.html` would
 * overwrite another project's preview, and enough `..` leaves the data
 * directory. Both separators count, so the answer is the same on Windows.
 *
 * A leading `/` is not an escape (the name is appended to the prefix) and the
 * Cloudflare target accepts `/index.html` as well as `index.html`, so it is
 * allowed here too; {@link localTarget} drops it before storing.
 */
export function isSafeAssetPath(path: string): boolean {
  if (path.includes("\0")) return false;
  const segments = path.split(/[\\/]/);
  if (segments.every((segment) => segment === "")) return false; // "", "/", "//"
  return !segments.includes("..");
}

/**
 * The deploy target of the local development server (src/local/serve.ts sets
 * DEPLOY_TARGET=local). There is no edge to upload to, so a deploy keeps its
 * client assets in ASSETS under `{projectId}/{deploymentId}/`, which is where
 * the local /preview/:slug/* route reads them from.
 *
 * Without this, a local deploy went through the Cloudflare target, which does
 * nothing when it has no API token: the deployment turned `active` with none
 * of its files kept, and the preview route had nothing to serve.
 *
 * Client assets only. A worker or SSR bundle's server files are not run or
 * stored: the preview route serves static files with an SPA fallback.
 */
export const localTarget: DeployTarget = {
  async deploy(env, _projectSlug, _teamSlug, deploymentId, input) {
    const row = await env.DB.prepare("SELECT projectId FROM deployment WHERE id = ?")
      .bind(deploymentId)
      .first<{ projectId: string }>();
    if (!row) throw new Error(`deployment ${deploymentId} not found`);
    // Every name is checked before the first write: a bundle with one bad
    // name stores nothing.
    const unsafe = Object.keys(input.clientAssets).find((path) => !isSafeAssetPath(path));
    if (unsafe !== undefined) {
      throw new Error(`unsafe asset path in bundle: ${JSON.stringify(unsafe)}`);
    }
    // `/index.html` and `index.html` are the same file, as on the Cloudflare target.
    const assets = Object.fromEntries(
      Object.entries(input.clientAssets).map(([path, data]) => [path.replace(/^\/+/, ""), data]),
    );
    await uploadAssetsToR2(env, row.projectId, deploymentId, assets);
  },
};
