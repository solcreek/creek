import type { Env } from "./types.js";
import { cfApi } from "@solcreek/deploy-core";

/**
 * Clean up expired sandboxes:
 * 1. Find sandboxes past their TTL
 * 2. Delete their WfP scripts from the sandbox namespace
 * 3. Mark as cleaned up in D1
 */
export async function cleanupExpiredSandboxes(env: Env): Promise<number> {
  const now = Date.now();

  // Find expired active sandboxes (batch of 20)
  const expired = await env.DB.prepare(
    `SELECT id, previewHost FROM deployments
     WHERE status = 'active' AND expiresAt < ? AND cleanedUpAt IS NULL
     LIMIT 20`,
  )
    .bind(now)
    .all<{ id: string; previewHost: string }>();

  let cleaned = 0;

  for (const sandbox of expired.results) {
    try {
      // Delete WfP script — script name is "{sandboxId}-sandbox"
      // (matches what deployWithAssets creates: {projectSlug}-{teamSlug})
      const scriptName = `${sandbox.id}-sandbox`;

      try {
        await cfApi(
          env,
          "DELETE",
          `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}`,
        );
      } catch {
        // Script might already be deleted or never created — continue
      }

      // Also delete the preview variant
      const previewScript = `${sandbox.id}-${sandbox.id.slice(0, 8)}-sandbox`;
      try {
        await cfApi(
          env,
          "DELETE",
          `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${previewScript}`,
        );
      } catch {
        // Ignore
      }

      // Mark as cleaned up
      await env.DB.prepare(
        "UPDATE deployments SET status = 'expired', cleanedUpAt = ? WHERE id = ?",
      )
        .bind(now, sandbox.id)
        .run();

      cleaned++;
    } catch {
      // Log but don't fail the batch
    }
  }

  // Also mark stale deploying sandboxes as failed (stuck for > 5 min)
  await env.DB.prepare(
    `UPDATE deployments SET status = 'failed', failedStep = 'deploying', errorMessage = 'Deploy timed out'
     WHERE status IN ('queued', 'deploying') AND createdAt < ?`,
  )
    .bind(now - 5 * 60 * 1000)
    .run();

  // Purge raw IP logs older than 30 days (legal data retention)
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "DELETE FROM deployments_ip_log WHERE createdAt < ?",
  )
    .bind(thirtyDaysAgo)
    .run();

  return cleaned;
}
