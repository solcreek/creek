import type { DeployTarget } from "./target.js";
import { uploadAssetsToR2 } from "./deploy.js";

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
    await uploadAssetsToR2(env, row.projectId, deploymentId, input.clientAssets);
  },
};
