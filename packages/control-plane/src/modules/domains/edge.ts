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
 * The sync cron's repair pass: links rows that have no edge id to the edge.
 * Returns how many it linked. Rows it can't register stay as they are and are
 * tried again on a later run.
 *
 * Active rows are included. Rows created before cfCustomHostnameId existed can
 * be active with a live custom hostname at the edge whose id was never stored
 * (production had one, verified 2026-09-28): linking adopts that hostname and
 * keeps the row active, and the status sync can then see it. An active row
 * whose edge hostname isn't active is moved back to pending by
 * linkCustomHostname. An edge that can't be reached changes nothing: a
 * transient failure must never take a serving domain down.
 *
 * Rows are taken in random order, so a hostname the edge keeps rejecting
 * can't hold the batch and starve the ones behind it.
 */
export async function linkUnregisteredDomains(env: Env, limit = 20): Promise<number> {
  if (!env.CLOUDFLARE_ZONE_ID) return 0;
  const rows = await env.DB.prepare(
    `SELECT id, hostname FROM custom_domain
     WHERE status IN ('pending', 'provisioning', 'active') AND cfCustomHostnameId IS NULL
     ORDER BY RANDOM()
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

/**
 * Records only the edge's id on the row, leaving its status alone. For a
 * caller that confirms the edge state itself before changing status (activate).
 */
export async function recordCustomHostnameId(
  env: Env,
  domainId: string,
  cfId: string,
): Promise<void> {
  await env.DB.prepare("UPDATE custom_domain SET cfCustomHostnameId = ? WHERE id = ?")
    .bind(cfId, domainId)
    .run();
}

/**
 * Records the edge's id on the row and lines its status up with the edge: an
 * active edge hostname makes the row active; a row marked active whose edge
 * hostname isn't active goes back to pending (dispatch only routes active
 * rows, and without an active edge hostname there is no certificate behind
 * it). Other statuses are left as they are.
 */
export async function linkCustomHostname(
  env: Env,
  domainId: string,
  cf: CustomHostnameResult,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE custom_domain SET cfCustomHostnameId = ?,
       status = CASE WHEN ? = 'active' THEN 'active' WHEN status = 'active' THEN 'pending' ELSE status END
     WHERE id = ?`,
  )
    .bind(cf.id, cf.status ?? null, domainId)
    .run();
}
