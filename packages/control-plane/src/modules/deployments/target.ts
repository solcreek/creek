import type { Env } from "../../types.js";
import { deployWithAssets, type DeployAssetsInput } from "./deploy.js";
import { creekdFleetTarget } from "./creekd-fleet.js";

/**
 * A deploy target is the execution substrate a built artifact is pushed to.
 *
 * Today Creek has exactly one: Cloudflare Workers for Platforms — upload a
 * worker + its assets to a WfP dispatch namespace. This seam exists so a Creek
 * *instance* can be configured for a different substrate — notably a creekd
 * fleet (the June Cloud / self-host-on-VM path) — without the deploy pipeline
 * (bundle read, resource provisioning, status/heartbeat/logging in
 * deploy-job.ts) knowing which one it is.
 *
 * `deploy` mirrors {@link deployWithAssets}'s contract exactly — side-effecting,
 * returns void; the public URL is derived by convention
 * `{project}-{team}.{CREEK_DOMAIN}` and resolved by the target's router (the CF
 * dispatch-worker today), not returned here — so wrapping today's CF path is a
 * behavior-preserving extraction. A richer surface (url/revisionId, rollback,
 * destroy) can land alongside the first non-CF target.
 */
export interface DeployTarget {
  deploy(
    env: Env,
    projectSlug: string,
    teamSlug: string,
    deploymentId: string,
    input: DeployAssetsInput,
    branch?: string | null,
    productionBranch?: string,
  ): Promise<void>;
}

/**
 * Cloudflare Workers for Platforms — the default target. Delegates to the
 * existing {@link deployWithAssets}; the CF-specific implementation stays in
 * deploy.ts. This wrapper is the DeployTarget-conforming seam, nothing more.
 */
export const cloudflareWfpTarget: DeployTarget = {
  deploy: deployWithAssets,
};

/**
 * Resolve the deploy target for this Creek instance from config. Defaults to
 * Cloudflare WfP so existing (creek.dev) deployments are unchanged; a june.cloud
 * instance sets DEPLOY_TARGET=creekd-fleet once that target is implemented.
 */
export function resolveDeployTarget(env: Env): DeployTarget {
  switch (env.DEPLOY_TARGET) {
    case "cloudflare-wfp":
    case undefined:
      return cloudflareWfpTarget;
    case "creekd-fleet":
      // The June Cloud / self-host-on-VM substrate. Requires CREEKD_ADMIN_URL
      // (validated at deploy time, per-call, like the CF target's token check).
      return creekdFleetTarget;
    default:
      throw new Error(`unknown DEPLOY_TARGET: ${env.DEPLOY_TARGET}`);
  }
}
