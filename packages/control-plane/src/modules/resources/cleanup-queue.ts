import type { Env } from "../../types.js";

/**
 * Tears down Cloudflare resources queued in `resource_cleanup_queue`: D1, R2
 * and KV from `DELETE /resources/:id`, custom hostnames from a project
 * deletion. Runs from the scheduled handler, a bounded batch per tick.
 *
 * A row is `done` only when Cloudflare confirms the delete (a 2xx whose
 * envelope doesn't say `success: false`), or answers 404 (already gone). Any other answer marks it `failed` and logs why, so a
 * resource that is still there is never recorded as cleaned up.
 *
 * D1, R2 and KV rows carry in cfResourceName the name Creek gave the
 * resource when it provisioned it. The resource is deleted only if it still
 * has that name: a resource row's cfResourceId can be caller-supplied, and
 * this keeps such an ID from deleting a resource Creek didn't create for it.
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
    // Claim the row. Overlapping runs can select the same pending row; only
    // the one whose claim changes it goes on to delete.
    const claim = await env.DB.prepare(
      "UPDATE resource_cleanup_queue SET status = 'cleaning' WHERE id = ? AND status = 'pending'",
    )
      .bind(row.id)
      .run();
    if (!claim.meta.changes) continue;

    try {
      const owned = await isCreekProvisioned(env, row);
      if (owned === "gone") {
        await env.DB.prepare(
          "UPDATE resource_cleanup_queue SET status = 'done' WHERE id = ? AND status = 'cleaning'",
        )
          .bind(row.id)
          .run();
        cleaned++;
        continue;
      }
      if (!owned) {
        throw new Error(
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

      await env.DB.prepare(
        "UPDATE resource_cleanup_queue SET status = 'done' WHERE id = ? AND status = 'cleaning'",
      )
        .bind(row.id)
        .run();
      cleaned++;
    } catch (err) {
      console.error(
        `[cleanup] ${row.resourceType} ${row.cfResourceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await env.DB.prepare(
        "UPDATE resource_cleanup_queue SET status = 'failed' WHERE id = ? AND status = 'cleaning'",
      )
        .bind(row.id)
        .run();
    }
  }

  return cleaned;
}

/**
 * Whether the queued D1/R2/KV resource is still the one Creek provisioned
 * under the expected name: true, false, or "gone" when Cloudflare no longer
 * has it. Other row types are not checked.
 */
async function isCreekProvisioned(
  env: Env,
  row: { resourceType: string; cfResourceId: string; cfResourceName: string },
): Promise<boolean | "gone"> {
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
  const body = (await res.json()) as { result?: Record<string, unknown> };
  return body.result?.[nameField] === row.cfResourceName;
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
