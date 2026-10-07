import type { Env } from "../../types.js";

/**
 * Tears down Cloudflare resources queued in `resource_cleanup_queue`: D1, R2
 * and KV from `DELETE /resources/:id`, custom hostnames from a project
 * deletion. Runs from the scheduled handler, a bounded batch per tick.
 *
 * A row is `done` only when Cloudflare confirms the delete (a 2xx whose
 * envelope doesn't say `success: false`), or answers 404 (already gone).
 * A failed attempt goes back to `pending` with backoff and is retried, up
 * to MAX_ATTEMPTS, then the row is `failed`. A row whose resource is still
 * referenced by a live resource row is `cancelled`, never deleted.
 *
 * Claims are leases: a run claims a row by setting `cleaning` and
 * `claimedAt`, and records the outcome only while that claim is still its
 * own. A run cut off mid-row leaves a claim that expires after
 * LEASE_SECONDS, and a later run reclaims it.
 *
 * D1, R2 and KV rows carry in cfResourceName the name Creek gave the
 * resource when it provisioned it. The resource is deleted only if it still
 * has that name: a resource row's cfResourceId can be caller-supplied, and
 * this keeps such an ID from deleting a resource Creek didn't create for it.
 */

/** A claim older than this is presumed abandoned and may be reclaimed. */
export const LEASE_SECONDS = 15 * 60;
/** Delete attempts before a row is marked failed. */
export const MAX_ATTEMPTS = 5;
/** Wait before retry n (1-based): 5, 10, 20, 40 minutes. */
export function retryDelaySeconds(attempt: number): number {
  return 5 * 60 * 2 ** (attempt - 1);
}

/** A failure that retrying cannot fix. */
class PermanentFailure extends Error {}

type QueueRow = {
  id: number;
  resourceType: string;
  cfResourceId: string;
  cfResourceName: string;
  attempts: number;
};

// Claimable: pending and due, or cleaning under an expired claim (including
// rows claimed before claims carried a time).
const CLAIMABLE = `(
  (status = 'pending' AND COALESCE(nextAttemptAt, 0) <= ?)
  OR (status = 'cleaning' AND COALESCE(claimedAt, 0) < ?)
)`;

export async function processResourceCleanupQueue(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - LEASE_SECONDS;
  const due = await env.DB.prepare(
    `SELECT id, resourceType, cfResourceId, cfResourceName, attempts
     FROM resource_cleanup_queue
     WHERE ${CLAIMABLE}
     ORDER BY id
     LIMIT 10`,
  )
    .bind(now, staleBefore)
    .all<QueueRow>();

  let cleaned = 0;

  for (const row of due.results) {
    // Claim the row. Overlapping runs can select the same row; only the one
    // whose claim changes it goes on to delete.
    const claim = await env.DB.prepare(
      `UPDATE resource_cleanup_queue
       SET status = 'cleaning', claimedAt = ?, attempts = attempts + 1
       WHERE id = ? AND ${CLAIMABLE}`,
    )
      .bind(now, row.id, now, staleBefore)
      .run();
    if (!claim.meta.changes) continue;
    const attempt = row.attempts + 1;

    // Record the outcome only while the claim is still this run's.
    const finish = (status: string, nextAttemptAt: number | null = null) =>
      env.DB.prepare(
        `UPDATE resource_cleanup_queue SET status = ?, nextAttemptAt = ?
         WHERE id = ? AND status = 'cleaning' AND claimedAt = ?`,
      )
        .bind(status, nextAttemptAt, row.id, now)
        .run();

    try {
      if (await isStillInUse(env, row)) {
        console.warn(
          `[cleanup] ${row.resourceType} ${row.cfResourceId} is referenced by a live resource; not deleting`,
        );
        await finish("cancelled");
        continue;
      }
      const owned = await isCreekProvisioned(env, row);
      if (owned === "gone") {
        await finish("done");
        cleaned++;
        continue;
      }
      if (!owned) {
        throw new PermanentFailure(
          `refusing to delete: it is not the resource Creek provisioned as ${row.cfResourceName}`,
        );
      }
      const url = cleanupUrl(env, row);
      if (url) {
        const res = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        });
        if (res.status !== 404) {
          // Cloudflare can report a failure in a 2xx envelope too.
          const body = await res.text().catch(() => "");
          let refused = !res.ok;
          try {
            refused ||= (JSON.parse(body) as { success?: unknown }).success === false;
          } catch {
            // Not JSON: the status decides.
          }
          if (refused) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
      }

      await finish("done");
      cleaned++;
    } catch (err) {
      const retry = !(err instanceof PermanentFailure) && attempt < MAX_ATTEMPTS;
      console.error(
        `[cleanup] ${row.resourceType} ${row.cfResourceId} attempt ${attempt} failed${retry ? ", will retry" : ""}:`,
        err instanceof Error ? err.message : err,
      );
      if (retry) await finish("pending", now + retryDelaySeconds(attempt));
      else await finish("failed");
    }
  }

  return cleaned;
}

/** Whether a live resource row still references the queued D1/R2/KV resource. */
async function isStillInUse(env: Env, row: QueueRow): Promise<boolean> {
  if (row.resourceType !== "d1" && row.resourceType !== "r2" && row.resourceType !== "kv") {
    return false;
  }
  const live = await env.DB.prepare(
    `SELECT 1 FROM resource WHERE cfResourceId = ? AND status != 'deleted' LIMIT 1`,
  )
    .bind(row.cfResourceId)
    .first();
  return live !== null;
}

/**
 * Whether the queued D1/R2/KV resource is still the one Creek provisioned
 * under the expected name: true, false, or "gone" when Cloudflare no longer
 * has it. Other row types are not checked.
 */
async function isCreekProvisioned(env: Env, row: QueueRow): Promise<boolean | "gone"> {
  const account = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  let url: string;
  let nameField: "name" | "title";
  switch (row.resourceType) {
    case "r2":
      // The bucket's ID is its name.
      return row.cfResourceId === row.cfResourceName;
    case "d1":
      url = `${account}/d1/database/${row.cfResourceId}`;
      nameField = "name";
      break;
    case "kv":
      url = `${account}/storage/kv/namespaces/${row.cfResourceId}`;
      nameField = "title";
      break;
    default:
      return true;
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  if (res.status === 404) return "gone";
  if (!res.ok) throw new Error(`lookup HTTP ${res.status}`);
  const body = (await res.json()) as {
    success?: boolean;
    result?: Record<string, unknown>;
  };
  // A 2xx can still carry a failed envelope. That's an API error to retry,
  // not evidence the resource has another name.
  if (body.success === false || !body.result) {
    throw new Error(`lookup failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result[nameField] === row.cfResourceName;
}

/** The Cloudflare API URL that deletes a queued resource, or null when there is none. */
function cleanupUrl(env: Env, row: QueueRow): string | null {
  const account = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  switch (row.resourceType) {
    case "d1":
      return `${account}/d1/database/${row.cfResourceId}`;
    case "r2":
      return `${account}/r2/buckets/${row.cfResourceName}`;
    case "kv":
      return `${account}/storage/kv/namespaces/${row.cfResourceId}`;
    case "custom_hostname":
      return env.CLOUDFLARE_ZONE_ID
        ? `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${row.cfResourceId}`
        : null;
    default:
      return null;
  }
}
