/**
 * Stable, machine-readable reason codes for a failed deployment, derived from
 * the deployment row's (failedStep, errorMessage).
 *
 * The deploying/activation stages don't upload a build log, so the only
 * structured signal an agent gets for those failures is the synthesized
 * fallback in routes.ts. A bare "Deploy timed out" isn't actionable, so this
 * maps the recorded failure onto a stable code + an actionable hint. Codes are
 * a contract — agents branch on them — so keep them stable. Pure + exported
 * for testing.
 */

export type DeployFailureCode =
  | "upload_timeout"
  | "provision_timeout"
  | "activation_timeout"
  | "bundle_too_large"
  | "binding_error"
  | "deploy_error";

export interface DeployFailureReason {
  code: DeployFailureCode;
  /** One-line, actionable next step. Safe to surface to users and agents. */
  hint: string;
}

export function classifyDeployFailure(
  failedStep: string | null,
  errorMessage: string | null,
): DeployFailureReason {
  const msg = (errorMessage ?? "").toLowerCase();

  // The reaper writes "...exceeded the N-minute deploy window..."; older rows
  // (and the bare path) say "timed out". Both mean the stage ran past its
  // window — almost always deterministic (volume), not a transient blip.
  const timedOut = msg.includes("timed out") || msg.includes("deploy window");
  if (timedOut) {
    switch (failedStep) {
      case "uploading":
        return {
          code: "upload_timeout",
          hint: "Bundle upload to staging ran past the deploy window — usually bundle size or a slow link. Shrink the bundle, then retry.",
        };
      case "provisioning":
        return {
          code: "provision_timeout",
          hint: "A backing resource (D1/R2/KV) didn't come up in time. Retry; if it persists, check that resource's status or quota.",
        };
      default:
        return {
          code: "activation_timeout",
          hint: "Edge activation ran past the deploy window — most often the asset count/size. Reduce assets or split the deploy, then retry.",
        };
    }
  }

  if (/payload too large|too large|size limit|over the .* limit/.test(msg)) {
    return {
      code: "bundle_too_large",
      hint: "The worker bundle is over the Workers size limit. Clear a stale .next/dev build or large inlined assets, then redeploy.",
    };
  }

  if (/binding|d1_error|no such (column|table)|\bdatabase\b|\br2\b|\bkv\b|resource/.test(msg)) {
    return {
      code: "binding_error",
      hint: "A resource binding or query failed at deploy. Check migrations are applied (creek db migrate) and the bindings exist.",
    };
  }

  return {
    code: "deploy_error",
    hint: "The deploy failed at the edge — see the message above. Retry the same command if it looks transient.",
  };
}
