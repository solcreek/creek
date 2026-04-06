import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { scheduleResourceDeletion } from "../resources/service.js";
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
  const body = await c.req.json<{ slug: string; framework?: string }>();

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

  const existing = await c.env.DB.prepare(
    "SELECT id FROM project WHERE slug = ? AND organizationId = ?",
  )
    .bind(body.slug, teamId)
    .first();

  if (existing) {
    return c.json({ error: "conflict", message: "Project slug already taken in this team" }, 409);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO project (id, slug, organizationId, framework, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.slug, teamId, body.framework ?? null, now, now)
    .run();

  const project = await c.env.DB.prepare("SELECT * FROM project WHERE id = ?")
    .bind(id)
    .first();

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "project.create",
    resourceType: "project",
    resourceId: id,
    metadata: { slug: body.slug },
  }, c.get("auditCtx"));

  return c.json({ project }, 201);
});

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
  await scheduleResourceDeletion(c.env, project.id);

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
