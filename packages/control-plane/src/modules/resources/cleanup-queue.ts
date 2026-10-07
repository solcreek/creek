import type { Env } from "../../types.js";

/**
 * Tears down Cloudflare resources queued in `resource_cleanup_queue`: D1, R2
 * and KV from `DELETE /resources/:id`, custom hostnames from a project
 * deletion. Runs from the scheduled handler, a bounded batch per tick.
 *
 * A row is `done` only when Cloudflare confirms the delete, or answers 404
 * (already gone). Any other answer marks it `failed` and logs why, so a
 * resource that is still there is never recorded as cleaned up.
 */
export async function processResourceCleanupQueue(env: Env): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, resourceType, cfResourceId, cfResourceName
     FROM resource_cleanup_queue
     WHERE status = 'pending'
     LIMIT 10`,
  ).all<{
    id: number;
    resourceType: string;
    cfResourceId: string;
    cfResourceName: string;
  }>();

  let cleaned = 0;

  for (const row of pending.results) {
    await env.DB.prepare("UPDATE resource_cleanup_queue SET status = 'cleaning' WHERE id = ?")
      .bind(row.id)
      .run();

    try {
      const url = cleanupUrl(env, row);
      if (url) {
        const res = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        });
        if (!res.ok && res.status !== 404) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
      }

      await env.DB.prepare("UPDATE resource_cleanup_queue SET status = 'done' WHERE id = ?")
        .bind(row.id)
        .run();
      cleaned++;
    } catch (err) {
      console.error(
        `[cleanup] ${row.resourceType} ${row.cfResourceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await env.DB.prepare("UPDATE resource_cleanup_queue SET status = 'failed' WHERE id = ?")
        .bind(row.id)
        .run();
    }
  }

  return cleaned;
}

/** The Cloudflare API URL that deletes a queued resource, or null when there is none. */
function cleanupUrl(
  env: Env,
  row: { resourceType: string; cfResourceId: string; cfResourceName: string },
): string | null {
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
