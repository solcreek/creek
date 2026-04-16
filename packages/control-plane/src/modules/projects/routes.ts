import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { scheduleResourceCleanup } from "../resources/service.js";
import { requirePermission } from "../tenant/permissions.js";

type ProjectEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; memberRole?: string; auditCtx: AuditRequestContext };
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
      { error: "validation", message: "Slug must be lowercase alphanumeric with hyphens, cannot start/end with hyphen" },
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
  const resolvedSlug = await findFreeSlug(c.env.DB, teamId, body.slug, body.autoResolveSlug ?? false);
  if (resolvedSlug === null) {
    return c.json({ error: "conflict", message: "Project slug already taken in this team" }, 409);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO project (id, slug, organizationId, framework, githubRepo, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      resolvedSlug,
      teamId,
      body.framework ?? null,
      body.githubRepo ?? null,
      now,
      now,
    )
    .run();

  const project = await c.env.DB.prepare("SELECT * FROM project WHERE id = ?")
    .bind(id)
    .first();

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "project.create",
    resourceType: "project",
    resourceId: id,
    metadata: { slug: resolvedSlug, requestedSlug: body.slug },
  }, c.get("auditCtx"));

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
  const existing = await db.prepare(
    "SELECT id FROM project WHERE slug = ? AND organizationId = ?",
  )
    .bind(baseSlug, teamId)
    .first();

  if (!existing) return baseSlug;
  if (!autoResolve) return null;

  for (let n = 2; n <= 100; n++) {
    const candidate = `${baseSlug}-${n}`;
    const row = await db.prepare(
      "SELECT id FROM project WHERE slug = ? AND organizationId = ?",
    )
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
  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(param, param, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Mark resources for async cleanup before deleting the project
  await scheduleResourceCleanup(c.env, project.id);

  await c.env.DB.prepare("DELETE FROM project WHERE id = ?")
    .bind(project.id)
    .run();

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "project.delete",
    resourceType: "project",
    resourceId: project.id,
  }, c.get("auditCtx"));

  return c.json({ ok: true });
});

export { projects };
