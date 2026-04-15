/**
 * Resources v2 routes — team-owned resources + project-level bindings.
 *
 * See product-planning/creek-resources-v2.md for the full design.
 *
 * Phase 1 scope (this file):
 *   - Plain CRUD on the `resource` + `project_resource_binding` tables.
 *   - NO CF provisioning yet. Callers set cfResourceId/Type directly or
 *     leave them null — the provisioner is wired in a later phase so
 *     existing deploys keep using the old project_resource path
 *     untouched.
 *   - All routes tenant-scoped; resources belong to the authenticated
 *     team. Bindings require the project to also be in that team.
 *
 * Two Hono sub-apps, mounted separately in index.ts:
 *   - `resources` at /resources        team-scoped resource CRUD
 *   - `resourceBindings` at /projects  per-project binding CRUD
 */

import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import { requirePermission } from "../tenant/permissions.js";

type ResourcesEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string };
};

// ---------------------------------------------------------------------
// /resources — team-scoped
// ---------------------------------------------------------------------

export const resources = new Hono<ResourcesEnv>();

const ALLOWED_KINDS = new Set(["database", "storage", "cache", "ai"]);
const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

resources.get("/", requirePermission("project:read"), async (c) => {
  const teamId = c.get("teamId");
  const rows = await c.env.DB.prepare(
    `SELECT id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt
     FROM resource
     WHERE teamId = ? AND status != 'deleted'
     ORDER BY createdAt DESC`,
  )
    .bind(teamId)
    .all();
  return c.json({ resources: rows.results });
});

resources.post("/", requirePermission("project:create"), async (c) => {
  const teamId = c.get("teamId");
  const body = await c.req.json<{
    kind?: string;
    name?: string;
    cfResourceId?: string;
    cfResourceType?: string;
  }>();

  if (!body.kind || !ALLOWED_KINDS.has(body.kind)) {
    return c.json(
      { error: "validation", message: `kind must be one of ${[...ALLOWED_KINDS].join("|")}` },
      400,
    );
  }
  if (!body.name || !NAME_RE.test(body.name)) {
    return c.json(
      {
        error: "validation",
        message:
          "name must match /^[a-z][a-z0-9_-]{0,62}$/ — lowercase, dash/underscore-friendly, ≤63 chars",
      },
      400,
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind(id, teamId, body.kind, body.name, body.cfResourceId ?? null, body.cfResourceType ?? null, now, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("constraint")) {
      return c.json(
        { error: "conflict", message: `A resource named '${body.name}' already exists in this team` },
        409,
      );
    }
    throw err;
  }

  return c.json(
    {
      id,
      teamId,
      kind: body.kind,
      name: body.name,
      cfResourceId: body.cfResourceId ?? null,
      cfResourceType: body.cfResourceType ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    201,
  );
});

resources.get("/:id", requirePermission("project:read"), async (c) => {
  const teamId = c.get("teamId");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt
     FROM resource
     WHERE id = ? AND teamId = ?`,
  )
    .bind(id, teamId)
    .first();
  if (!row) return c.json({ error: "not_found" }, 404);

  // Include current bindings — cheap and high-signal for the dashboard.
  const bindings = await c.env.DB.prepare(
    `SELECT b.projectId, b.bindingName, p.slug as projectSlug
     FROM project_resource_binding b
     JOIN project p ON b.projectId = p.id
     WHERE b.resourceId = ?`,
  )
    .bind(id)
    .all();

  return c.json({ ...(row as object), bindings: bindings.results });
});

resources.patch("/:id", requirePermission("project:create"), async (c) => {
  const teamId = c.get("teamId");
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || !NAME_RE.test(body.name)) {
    return c.json({ error: "validation", message: "name required and must match naming rule" }, 400);
  }
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `UPDATE resource SET name = ?, updatedAt = ? WHERE id = ? AND teamId = ?`,
  )
    .bind(body.name, now, id, teamId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ id, name: body.name, updatedAt: now });
});

resources.delete("/:id", requirePermission("project:create"), async (c) => {
  const teamId = c.get("teamId");
  const id = c.req.param("id");

  // Refuse deletion while bindings still exist — user must detach first.
  const attachments = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM project_resource_binding WHERE resourceId = ?`,
  )
    .bind(id)
    .first<{ n: number }>();
  if ((attachments?.n ?? 0) > 0) {
    return c.json(
      {
        error: "has_bindings",
        message: `Resource is attached to ${attachments?.n} project(s). Detach first.`,
      },
      409,
    );
  }

  // Soft-delete. Actual CF resource cleanup is a separate concern (reuses
  // resource_cleanup_queue once provisioning is wired).
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `UPDATE resource SET status = 'deleted', updatedAt = ? WHERE id = ? AND teamId = ? AND status != 'deleted'`,
  )
    .bind(now, id, teamId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ id, status: "deleted" });
});

// ---------------------------------------------------------------------
// /projects/:slug/bindings — per-project
// ---------------------------------------------------------------------

export const resourceBindings = new Hono<ResourcesEnv>();

const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

async function getProjectForTeam(
  env: Env,
  teamId: string,
  slug: string,
): Promise<{ id: string } | null> {
  return env.DB.prepare(
    `SELECT id FROM project WHERE slug = ? AND organizationId = ?`,
  )
    .bind(slug, teamId)
    .first<{ id: string }>();
}

resourceBindings.get(
  "/:slug/bindings",
  requirePermission("project:read"),
  async (c) => {
    const teamId = c.get("teamId");
    const slug = c.req.param("slug") ?? "";
    const project = await getProjectForTeam(c.env, teamId, slug);
    if (!project) return c.json({ error: "not_found" }, 404);

    const rows = await c.env.DB.prepare(
      `SELECT b.bindingName, b.createdAt, r.id as resourceId, r.kind, r.name, r.status
       FROM project_resource_binding b
       JOIN resource r ON b.resourceId = r.id
       WHERE b.projectId = ?
       ORDER BY b.bindingName`,
    )
      .bind(project.id)
      .all();
    return c.json({ bindings: rows.results });
  },
);

resourceBindings.post(
  "/:slug/bindings",
  requirePermission("project:create"),
  async (c) => {
    const teamId = c.get("teamId");
    const slug = c.req.param("slug") ?? "";
    const project = await getProjectForTeam(c.env, teamId, slug);
    if (!project) return c.json({ error: "not_found", message: "project" }, 404);

    const body = await c.req.json<{ resourceId?: string; bindingName?: string }>();
    if (!body.resourceId) return c.json({ error: "validation", message: "resourceId required" }, 400);
    if (!body.bindingName || !BINDING_NAME_RE.test(body.bindingName)) {
      return c.json(
        {
          error: "validation",
          message:
            "bindingName required and must match /^[A-Z][A-Z0-9_]{0,62}$/ — ENV var shape",
        },
        400,
      );
    }

    const resourceRow = await c.env.DB.prepare(
      `SELECT id FROM resource WHERE id = ? AND teamId = ? AND status != 'deleted'`,
    )
      .bind(body.resourceId, teamId)
      .first();
    if (!resourceRow) return c.json({ error: "not_found", message: "resource" }, 404);

    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(project.id, body.bindingName, body.resourceId, now)
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        return c.json(
          {
            error: "conflict",
            message: `Binding '${body.bindingName}' already exists for this project`,
          },
          409,
        );
      }
      throw err;
    }

    return c.json(
      {
        projectId: project.id,
        bindingName: body.bindingName,
        resourceId: body.resourceId,
        createdAt: now,
      },
      201,
    );
  },
);

resourceBindings.delete(
  "/:slug/bindings/:name",
  requirePermission("project:create"),
  async (c) => {
    const teamId = c.get("teamId");
    const slug = c.req.param("slug") ?? "";
    const project = await getProjectForTeam(c.env, teamId, slug);
    if (!project) return c.json({ error: "not_found" }, 404);

    const res = await c.env.DB.prepare(
      `DELETE FROM project_resource_binding WHERE projectId = ? AND bindingName = ?`,
    )
      .bind(project.id, c.req.param("name"))
      .run();
    if (!res.meta.changes) return c.json({ error: "not_found", message: "binding" }, 404);
    return c.json({ ok: true });
  },
);
