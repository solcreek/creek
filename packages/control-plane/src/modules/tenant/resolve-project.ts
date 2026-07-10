import type { D1Database } from "@cloudflare/workers-types";

/**
 * Column superset needed by every ownership-check call site across
 * deployments/domains/env/github/projects routes. Extend this (and the SELECT
 * below) if a new call site needs another column — don't reach for `SELECT *`.
 */
export interface ResolvedProject {
  id: string;
  slug: string;
  productionDeploymentId: string | null;
  productionBranch: string;
  framework: string | null;
  triggers: string | null;
}

/**
 * Resolve a project owned by `teamId`, by id or slug. This is the ownership
 * check duplicated across deployments/domains/env/github/projects routes:
 * `SELECT ... FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?`.
 *
 * Returns null when not found — the caller sends the 404 so each route keeps
 * full control over its response shape/status.
 */
export async function resolveProject(
  db: D1Database,
  idOrSlug: string,
  teamId: string,
): Promise<ResolvedProject | null> {
  return db
    .prepare(
      `SELECT id, slug, productionDeploymentId, productionBranch, framework, triggers
       FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?`,
    )
    .bind(idOrSlug, idOrSlug, teamId)
    .first<ResolvedProject>();
}
