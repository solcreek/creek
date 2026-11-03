import type { Env } from "../../types.js";
import { deleteStagedBundle } from "./deploy-job.js";

/**
 * A deployment stays `queued` until its bundle arrives (PUT /bundle, from the
 * CLI or the remote builder) or, for a GitHub push, until the remote build
 * reports back. If the CLI is interrupted or loses its connection first, or
 * the push handler dies mid-build, nothing moves the row on: the stale-deploy
 * sweep only covers uploading / provisioning / deploying, so it stayed
 * `queued` forever, listed as in flight by the dashboard and the CLI.
 *
 * Fail those rows once they are an hour old. That is far past any real
 * upload or build: the CLI's upload has per-request timeouts, and 0.4.55 and
 * older, which had none, took at most ~17 minutes on the slowest observed
 * link. A bundle that still arrives afterwards is accepted anyway: PUT
 * /serverfile and PUT /bundle take a `failed` deployment and restart it.
 */
export const ABANDONED_QUEUED_MS = 60 * 60 * 1000;

/**
 * Rows failed per cron tick. Each one also reclaims its R2 staging (a list
 * and a few deletes), so a backlog drains over several ticks instead of one
 * long invocation.
 */
export const ABANDONED_QUEUED_BATCH = 50;

export const ABANDONED_UPLOAD_MESSAGE =
  "The bundle upload never arrived — the deploy command stopped (interrupted, or lost its connection) before sending it. Nothing was activated; run the deploy again.";
export const ABANDONED_BUILD_MESSAGE =
  "The remote build never reported back, so nothing was activated. Push again or redeploy from the dashboard.";

export async function sweepAbandonedQueuedDeployments(
  env: Env,
  now: number = Date.now(),
): Promise<number> {
  // RETURNING gives exactly the rows this statement failed, so staging is
  // reclaimed only for them, with no SELECT-then-UPDATE race.
  const result = await env.DB.prepare(
    `UPDATE deployment
     SET status = 'failed',
         failedStep = CASE triggerType WHEN 'github' THEN 'building' ELSE 'uploading' END,
         errorMessage = CASE triggerType WHEN 'github' THEN ? ELSE ? END,
         updatedAt = ?
     WHERE id IN (
       SELECT id FROM deployment
       WHERE status = 'queued' AND updatedAt < ?
       ORDER BY updatedAt
       LIMIT ?
     )
     RETURNING id`,
  )
    .bind(
      ABANDONED_BUILD_MESSAGE,
      ABANDONED_UPLOAD_MESSAGE,
      now,
      now - ABANDONED_QUEUED_MS,
      ABANDONED_QUEUED_BATCH,
    )
    .all<{ id: string }>();

  const ids = result.results ?? [];
  for (const { id } of ids) {
    await deleteStagedBundle(env, id);
  }
  return ids.length;
}

/**
 * Whether the queued sweep failed this deployment. Such a deployment is
 * final: the upload routes refuse it (409 `abandoned`), so nothing restages
 * it while the sweep reclaims its staging, and a late upload cannot restart
 * a deploy whose files were just deleted. The deploy command creates a new
 * deployment instead.
 */
export function isAbandonedDeployment(row: { status: string; errorMessage?: string | null }) {
  return (
    row.status === "failed" &&
    (row.errorMessage === ABANDONED_UPLOAD_MESSAGE || row.errorMessage === ABANDONED_BUILD_MESSAGE)
  );
}

export const ABANDONED_REFUSAL =
  "This deployment was abandoned: its upload did not arrive within an hour, so it was failed and its staged files were removed. Run the deploy again; that creates a new deployment.";
