import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { scheduleResourceCleanup } from "../resources/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { resolveProject } from "../tenant/resolve-project.js";

type ProjectEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    teamId: string;
    teamSlug: string;
    memberRole?: string;
    auditCtx: AuditRequestContext;
  };
};

const projects = new Hono<ProjectEnv>();

projects.get("/", async (c) => {
  const teamId = c.get("teamId");
  const rows = await c.env.DB.prepare(
    "SELECT * FROM project WHERE organizationId = ? ORDER BY updatedAt DESC",
  )
    .bind(teamId)
    .all();

  return c.json(rows.results);
});

projects.post("/", requirePermission("project:create"), async (c) => {
  const teamId = c.get("teamId");
  const body = await c.req.json<{
    slug: string;
    framework?: string;
    githubRepo?: string;
    // Opt-in: when true and the requested slug is taken inside the team,
    // the server auto-appends a numeric suffix (`-2`, `-3`, ...) until it
    // finds a free slug instead of returning 409. Used by the dashboard
    // GitHub import flow where the caller doesn't want to block on slug
    // collisions between repos of the same name across different orgs.
    autoResolveSlug?: boolean;
  }>();

  if (!body.slug || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug)) {
    return c.json(
      {
        error: "validation",
        message: "Slug must be lowercase alphanumeric with hyphens, cannot start/end with hyphen",
      },
      400,
    );
  }

  if (body.slug.includes("-git-")) {
    return c.json(
      { error: "validation", message: "Slug cannot contain '-git-' (reserved for branch URLs)" },
      400,
    );
  }

  // Find a free slug. In strict mode (the default) we return 409 on any
  // collision. In auto-resolve mode we walk base, base-2, base-3... until
  // the team has no project with that slug.
  const resolvedSlug = await findFreeSlug(
    c.env.DB,
    teamId,
    body.slug,
    body.autoResolveSlug ?? false,
  );
  if (resolvedSlug === null) {
    return c.json({ error: "conflict", message: "Project slug already taken in this team" }, 409);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO project (id, slug, organizationId, framework, githubRepo, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, resolvedSlug, teamId, body.framework ?? null, body.githubRepo ?? null, now, now)
    .run();

  const project = await c.env.DB.prepare("SELECT * FROM project WHERE id = ?").bind(id).first();

  await recordAudit(
    c.env.DB,
    c.get("user"),
    c.get("teamId"),
    {
      action: "project.create",
      resourceType: "project",
      resourceId: id,
      metadata: { slug: resolvedSlug, requestedSlug: body.slug },
    },
    c.get("auditCtx"),
  );

  return c.json({ project }, 201);
});

/**
 * Resolve a project slug inside a team, optionally appending a numeric suffix
 * on collision. Returns:
 *   - the input slug if it's free
 *   - `${base}-N` (N = 2, 3, ...) if auto-resolve is on and base is taken
 *   - null if auto-resolve is off and base is taken
 *
 * Caps at 100 attempts so a pathologically crowded team doesn't loop forever.
 */
async function findFreeSlug(
  db: D1Database,
  teamId: string,
  baseSlug: string,
  autoResolve: boolean,
): Promise<string | null> {
  const existing = await db
    .prepare("SELECT id FROM project WHERE slug = ? AND organizationId = ?")
    .bind(baseSlug, teamId)
    .first();

  if (!existing) return baseSlug;
  if (!autoResolve) return null;

  for (let n = 2; n <= 100; n++) {
    const candidate = `${baseSlug}-${n}`;
    const row = await db
      .prepare("SELECT id FROM project WHERE slug = ? AND organizationId = ?")
      .bind(candidate, teamId)
      .first();
    if (!row) return candidate;
  }

  return null; // 100 consecutive collisions — give up
}

projects.get("/:idOrSlug", async (c) => {
  const teamId = c.get("teamId");
  const param = c.req.param("idOrSlug");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(param, param, teamId)
    .first();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  return c.json(project);
});

projects.delete("/:idOrSlug", requirePermission("project:delete"), async (c) => {
  const teamId = c.get("teamId");
  const param = c.req.param("idOrSlug");

  // Look up project first so we can schedule resource cleanup
  const project = await resolveProject(c.env.DB, param!, teamId);

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Mark resources for async cleanup before deleting the project — this reads
  // custom_domain, so it must run before those rows are removed below.
  await scheduleResourceCleanup(c.env, project.id);

  // Delete the project's child rows before the project itself. D1 enforces the
  // foreign keys (deployment/env/domain/github/binding -> project, build_log ->
  // deployment) and none is ON DELETE CASCADE, so deleting the project directly
  // fails with "FOREIGN KEY constraint failed" for any project that was ever
  // deployed. Order matters (grandchild build_log first); a batch runs them in
  // one transaction so a mid-way failure can't orphan rows. Team-owned resources
  // (D1/R2/KV) are intentionally NOT deleted — only the binding rows.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM build_log WHERE deploymentId IN (SELECT id FROM deployment WHERE projectId = ?)",
      ).bind(project.id),
      c.env.DB.prepare("DELETE FROM deployment WHERE projectId = ?").bind(project.id),
      c.env.DB.prepare("DELETE FROM environment_variable WHERE projectId = ?").bind(project.id),
      c.env.DB.prepare("DELETE FROM custom_domain WHERE projectId = ?").bind(project.id),
      c.env.DB.prepare("DELETE FROM github_connection WHERE projectId = ?").bind(project.id),
      c.env.DB.prepare("DELETE FROM project_resource_binding WHERE projectId = ?").bind(project.id),
      c.env.DB.prepare("DELETE FROM project WHERE id = ?").bind(project.id),
    ]);
  } catch (err) {
    console.error(`[projects] delete failed for ${project.id}:`, err);
    return c.json(
      {
        error: "delete_failed",
        message: err instanceof Error ? err.message : "Failed to delete project",
      },
      500,
    );
  }

  await recordAudit(
    c.env.DB,
    c.get("user"),
    c.get("teamId"),
    {
      action: "project.delete",
      resourceType: "project",
      resourceId: project.id,
    },
    c.get("auditCtx"),
  );

  return c.json({ ok: true });
});

export { projects };
