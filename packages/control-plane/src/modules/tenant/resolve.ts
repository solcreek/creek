import type { D1Database } from "@cloudflare/workers-types";

export interface ResolvedTeam {
  id: string;
  slug: string;
}

export type ResolveTeamResult =
  | { ok: true; team: ResolvedTeam }
  | { ok: false; error: "not_found" | "no_team"; message: string };

/**
 * Resolve the active team for a user. Pure function — no middleware, no session.
 *
 * Resolution order:
 *   1. Explicit team slug (from x-creek-team header)
 *   2. Session's activeOrganizationId
 *   3. First org the user belongs to (fallback)
 *
 * All paths verify membership via D1 query.
 */
export async function resolveTeam(
  db: D1Database,
  userId: string,
  teamSlugHeader: string | undefined,
  activeOrganizationId: string | null,
): Promise<ResolveTeamResult> {
  // 1. Explicit team slug — verify membership
  if (teamSlugHeader) {
    const org = await db
      .prepare(
        `SELECT o.id, o.slug FROM organization o
         JOIN member m ON m.organizationId = o.id
         WHERE o.slug = ? AND m.userId = ?`,
      )
      .bind(teamSlugHeader, userId)
      .first<ResolvedTeam>();

    if (!org) {
      return { ok: false, error: "not_found", message: "Team not found or you are not a member" };
    }
    return { ok: true, team: org };
  }

  // 2. Session's active org — verify membership
  if (activeOrganizationId) {
    const org = await db
      .prepare(
        `SELECT o.id, o.slug FROM organization o
         JOIN member m ON m.organizationId = o.id
         WHERE o.id = ? AND m.userId = ?`,
      )
      .bind(activeOrganizationId, userId)
      .first<ResolvedTeam>();

    if (org) {
      return { ok: true, team: org };
    }
    // Stale — fall through
  }

  // 3. Fallback: first org the user belongs to
  const org = await db
    .prepare(
      `SELECT o.id, o.slug FROM organization o
       JOIN member m ON m.organizationId = o.id
       WHERE m.userId = ?
       ORDER BY m.createdAt ASC
       LIMIT 1`,
    )
    .bind(userId)
    .first<ResolvedTeam>();

  if (!org) {
    return { ok: false, error: "no_team", message: "No team found. Create one first." };
  }
  return { ok: true, team: org };
}
