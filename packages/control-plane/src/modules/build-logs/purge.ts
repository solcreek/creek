/**
 * Retention for build logs. Called from the scheduled cron handler.
 *
 * Policy (see product-planning/creek-build-logs.md):
 *   - success: 30 days
 *   - failed:  90 days
 *   - running: left alone — a stuck row gets cleaned up by the
 *     separate `sweepStaleDeployments` mechanism, not here.
 *
 * Each cron tick processes a bounded batch so one invocation can't
 * monopolize the 30s worker budget. Cron runs every 5 min, so a
 * large backlog drains over a few hours rather than one spike.
 */

import type { Env } from "../../types.js";

const BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS: Record<string, number> = {
  success: 30 * DAY_MS,
  failed: 90 * DAY_MS,
};

export async function purgeExpiredBuildLogs(env: Env): Promise<number> {
  if (!env.LOGS_BUCKET) return 0;
  const now = Date.now();

  // Candidate rows: status in {success, failed} and endedAt < now - retention.
  // Express as two branches in one query to keep it a single round-trip.
  const successCutoff = now - RETENTION_MS.success;
  const failedCutoff = now - RETENTION_MS.failed;

  const rows = await env.DB.prepare(
    `SELECT deploymentId, r2Key
     FROM build_log
     WHERE (status = 'success' AND endedAt < ?)
        OR (status = 'failed'  AND endedAt < ?)
     LIMIT ?`,
  )
    .bind(successCutoff, failedCutoff, BATCH_SIZE)
    .all<{ deploymentId: string; r2Key: string }>();

  let deleted = 0;
  for (const row of rows.results) {
    // R2 delete is best-effort — if it fails, the D1 row still gets
    // removed and the object becomes orphan storage (rare enough to
    // accept; a separate R2 lifecycle rule could reap orphans later).
    try {
      await env.LOGS_BUCKET.delete(row.r2Key);
    } catch {
      // swallow — proceed to D1 cleanup anyway
    }
    await env.DB.prepare("DELETE FROM build_log WHERE deploymentId = ?")
      .bind(row.deploymentId)
      .run();
    deleted++;
  }

  return deleted;
}
