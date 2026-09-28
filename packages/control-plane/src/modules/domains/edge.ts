import type { Env } from "../../types.js";
import {
  createCustomHostname,
  findCustomHostnameByName,
  type CustomHostnameResult,
} from "../resources/cloudflare.js";

/**
 * Registers `hostname` as a CF for SaaS custom hostname, or adopts the one
 * already registered (a create whose response was lost, or a retry after a
 * partial failure). Returns null when the edge can't be reached, so the caller
 * keeps the domain pending and tries again later.
 *
 * A custom_domain row without a cfCustomHostnameId has no certificate and no
 * edge validation behind it: every path that finds one (add, activate, the
 * sync cron) calls this rather than treating the row as done.
 */
export async function createOrAdoptCustomHostname(
  env: Env,
  hostname: string,
): Promise<CustomHostnameResult | null> {
  try {
    const created = await createCustomHostname(env, hostname);
    if (created?.id) return created;
  } catch (err) {
    console.error("[domains] CF custom hostname create failed:", hostname, err);
  }
  try {
    return await findCustomHostnameByName(env, hostname);
  } catch (err) {
    console.error("[domains] CF custom hostname lookup failed:", hostname, err);
    return null;
  }
}

/**
 * The sync cron's repair pass: registers pending rows that never reached the
 * edge. Returns how many it linked. Rows it can't register stay as they are
 * and are tried again on the next run.
 */
export async function linkUnregisteredDomains(env: Env, limit = 20): Promise<number> {
  if (!env.CLOUDFLARE_ZONE_ID) return 0;
  const rows = await env.DB.prepare(
    `SELECT id, hostname FROM custom_domain
     WHERE status IN ('pending', 'provisioning') AND cfCustomHostnameId IS NULL
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; hostname: string }>();

  let linked = 0;
  for (const row of rows.results) {
    const cf = await createOrAdoptCustomHostname(env, row.hostname);
    if (!cf) continue;
    await linkCustomHostname(env, row.id, cf);
    linked++;
  }
  return linked;
}

/** Records the edge's id on the row, and marks it active if the edge already is. */
export async function linkCustomHostname(
  env: Env,
  domainId: string,
  cf: CustomHostnameResult,
): Promise<void> {
  const status = cf.status === "active" ? "active" : null;
  await env.DB.prepare(
    "UPDATE custom_domain SET cfCustomHostnameId = ?, status = COALESCE(?, status) WHERE id = ?",
  )
    .bind(cf.id, status, domainId)
    .run();
}
