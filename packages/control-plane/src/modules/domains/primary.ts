import type { Env } from "../../types.js";

/**
 * A project's primary custom domain: the one its default
 * {project}-{team} hostname redirects to (dispatch-worker) when
 * project.redirectToPrimaryDomain is on. At most one per project, held by the
 * partial unique index idx_custom_domain_primary.
 *
 * The Worker deploys on merge and migrations are applied by hand, so the
 * bookkeeping that runs inside `add` and `remove` must not fail those routes
 * before migration 0014 exists: it reports "not available" instead.
 */

/** Whether `err` is SQLite reporting a column that migration 0014 adds. */
export function isMissingPrimaryColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such column: .*(isPrimary|redirectToPrimaryDomain)/i.test(message);
}

/**
 * Makes `domainId` the project's primary domain when it has none: a project's
 * first domain is its canonical address without anyone having to say so.
 * Returns whether it was made primary.
 */
export async function claimPrimaryIfNone(
  env: Env,
  projectId: string,
  domainId: string,
): Promise<boolean> {
  try {
    const result = await env.DB.prepare(
      `UPDATE custom_domain SET isPrimary = 1
       WHERE id = ? AND projectId = ?
         AND NOT EXISTS (SELECT 1 FROM custom_domain WHERE projectId = ? AND isPrimary = 1)`,
    )
      .bind(domainId, projectId, projectId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    if (isMissingPrimaryColumn(err)) return false;
    throw err;
  }
}

/**
 * After a domain is removed: when the project is left with domains but no
 * primary, the oldest active one takes over (the oldest of any status when
 * none is active), so the default hostname keeps a canonical address instead
 * of silently going back to serving both.
 */
export async function promotePrimaryIfNone(env: Env, projectId: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE custom_domain SET isPrimary = 1
       WHERE id = (
         SELECT id FROM custom_domain WHERE projectId = ?
         ORDER BY (status = 'active') DESC, createdAt ASC, id ASC LIMIT 1
       )
       AND NOT EXISTS (SELECT 1 FROM custom_domain WHERE projectId = ? AND isPrimary = 1)`,
    )
      .bind(projectId, projectId)
      .run();
  } catch (err) {
    if (!isMissingPrimaryColumn(err)) throw err;
  }
}

/**
 * Moves the primary mark to `domainId`. The two statements run as one batch
 * (a transaction on D1): the old mark is cleared first because the unique
 * index allows one primary per project at every step.
 */
export async function setPrimary(env: Env, projectId: string, domainId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE custom_domain SET isPrimary = 0 WHERE projectId = ? AND isPrimary = 1 AND id != ?",
    ).bind(projectId, domainId),
    env.DB.prepare("UPDATE custom_domain SET isPrimary = 1 WHERE id = ? AND projectId = ?").bind(
      domainId,
      projectId,
    ),
  ]);
}
