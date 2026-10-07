/**
 * Resources routes — team-owned resources + project-level bindings.
 *
 * Resources are first-class team-scoped entities with stable UUIDs and
 * mutable names. They are attached to projects via bindings (env var
 * name → resource ID). One resource can be bound to many projects.
 *
 * CF provisioning (D1/R2/KV) happens eagerly on POST /resources. The
 * deploy pipeline reads `project_resource_binding` to resolve which
 * CF resources a project needs at deploy time.
 *
 * Two Hono sub-apps, mounted separately in index.ts:
 *   - `resources` at /resources        team-scoped resource CRUD
 *   - `resourceBindings` at /projects  per-project binding CRUD
 */

import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import { requirePermission } from "../tenant/permissions.js";
import { provisionCFResource, findExistingCFResource } from "./cloudflare.js";

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

  // Map semantic kind → CF resource type for provisionable resources
  const KIND_TO_CF: Record<string, string> = {
    database: "d1",
    storage: "r2",
    cache: "kv",
  };
  const cfType = KIND_TO_CF[body.kind] ?? null;

  // Auto-provision the CF resource if it's a provisionable type.
  // Use the resource UUID prefix as the CF resource name for uniqueness.
  let cfResourceId = body.cfResourceId ?? null;
  if (!cfResourceId && cfType) {
    const cfName = `creek-${id.slice(0, 8)}`;
    try {
      cfResourceId =
        (await findExistingCFResource(c.env, cfType, cfName)) ??
        (await provisionCFResource(c.env, cfType, cfName));
    } catch (err) {
      return c.json(
        {
          error: "provisioning_failed",
          message: `Failed to provision ${body.kind}: ${err instanceof Error ? err.message : String(err)}`,
        },
        502,
      );
    }
  }

  try {
    // A Cloudflare resource queued for teardown can't be adopted: the cleanup
    // would delete it under the new row. Checked in the same statement as
    // the insert, so it can't race the queue's claim (the cleanup also skips
    // a resource a live row references).
    const inserted = await c.env.DB.prepare(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM resource_cleanup_queue q
         WHERE q.cfResourceId = ? AND q.status IN ('pending', 'cleaning')
       )`,
    )
      .bind(
        id,
        teamId,
        body.kind,
        body.name,
        cfResourceId,
        cfType ?? body.cfResourceType ?? null,
        now,
        now,
        cfResourceId,
      )
      .run();
    if (!inserted.meta.changes) {
      return c.json(
        {
          error: "conflict",
          message:
            "That Cloudflare resource is being deleted and can't be attached to a new resource.",
        },
        409,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("constraint")) {
      return c.json(
        {
          error: "conflict",
          message: `A resource named '${body.name}' already exists in this team`,
        },
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
      cfResourceId,
      cfResourceType: cfType ?? body.cfResourceType ?? null,
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
    return c.json(
      { error: "validation", message: "name required and must match naming rule" },
      400,
    );
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

  // Soft-delete the row and queue the Cloudflare resource behind it for
  // teardown, in one batch so neither happens without the other. The
  // scheduled cleanup deletes it on its next run; the data is not
  // recoverable after that. Both statements match the same live row, so a
  // missing or already-deleted resource queues nothing.
  //
  // cfResourceId can come from the caller (POST /resources accepts one), so
  // it is not proof the resource is this team's. The queue records the name
  // Creek gives every resource it provisions, `creek-<first 8 of id>`, and
  // the cleanup deletes only a resource that still carries it. Nothing is
  // queued while another live row points at the same Cloudflare resource.
  //
  // The binding check above only gives the 409 its message: a project can
  // attach the resource after it. Both statements therefore also require it
  // to be unbound, and attach inserts only for a live resource, so D1's
  // serialized writes settle the race one way or the other.
  const now = Date.now();
  const [, res] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason, createdAt)
       SELECT type, cfResourceId, 'creek-' || substr(id, 1, 8), 'pending', 'resource_deleted', ?
       FROM (
         -- Older rows may lack cfResourceType; fall back to kind, as provisioning does.
         SELECT cfResourceId, status, id, teamId,
                COALESCE(cfResourceType, CASE kind WHEN 'database' THEN 'd1'
                  WHEN 'storage' THEN 'r2' WHEN 'cache' THEN 'kv' END) AS type
         FROM resource
       ) r
       WHERE id = ? AND teamId = ? AND status != 'deleted'
         AND cfResourceId IS NOT NULL AND type IN ('d1', 'r2', 'kv')
         AND NOT EXISTS (
           SELECT 1 FROM resource other
           WHERE other.cfResourceId = r.cfResourceId AND other.id != r.id
             AND other.status != 'deleted'
         )
         AND NOT EXISTS (SELECT 1 FROM project_resource_binding b WHERE b.resourceId = r.id)`,
    ).bind(Math.floor(now / 1000), id, teamId),
    c.env.DB.prepare(
      `UPDATE resource SET status = 'deleted', updatedAt = ?
       WHERE id = ? AND teamId = ? AND status != 'deleted'
         AND NOT EXISTS (SELECT 1 FROM project_resource_binding b WHERE b.resourceId = resource.id)`,
    ).bind(now, id, teamId),
  ]);
  if (!res.meta.changes) {
    // Either it's gone, or a project attached it since the check above.
    const bound = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_resource_binding b
       JOIN resource r ON r.id = b.resourceId
       WHERE r.id = ? AND r.teamId = ? AND r.status != 'deleted'`,
    )
      .bind(id, teamId)
      .first<{ n: number }>();
    if ((bound?.n ?? 0) > 0) {
      return c.json(
        {
          error: "has_bindings",
          message: `Resource is attached to ${bound?.n} project(s). Detach first.`,
        },
        409,
      );
    }
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ id, status: "deleted" });
});

/**
 * POST /resources/:id/query — execute SQL against a D1 database resource.
 * Proxies to the CF D1 HTTP API. Only works for kind=database resources.
 */
resources.post("/:id/query", requirePermission("project:create"), async (c) => {
  const teamId = c.get("teamId");
  const id = c.req.param("id");

  const resource = await c.env.DB.prepare(
    `SELECT kind, cfResourceId, cfResourceType, status FROM resource WHERE id = ? AND teamId = ?`,
  )
    .bind(id, teamId)
    .first<{
      kind: string;
      cfResourceId: string | null;
      cfResourceType: string | null;
      status: string;
    }>();

  if (!resource) return c.json({ error: "not_found" }, 404);
  if (resource.kind !== "database" || resource.cfResourceType !== "d1") {
    return c.json(
      { error: "invalid_kind", message: "Query is only supported for database resources" },
      400,
    );
  }
  if (!resource.cfResourceId) {
    return c.json({ error: "not_provisioned", message: "Database not yet provisioned" }, 400);
  }

  const body = await c.req.json<{ sql?: string; params?: unknown[] }>();
  if (!body.sql || typeof body.sql !== "string") {
    return c.json({ error: "validation", message: "sql field required" }, 400);
  }
  if (body.sql.length > 100_000) {
    return c.json({ error: "validation", message: "SQL query too large (max 100KB)" }, 400);
  }
  if (body.params && !Array.isArray(body.params)) {
    return c.json({ error: "validation", message: "params must be an array" }, 400);
  }
  if (resource.status !== "active") {
    return c.json({ error: "not_active", message: `Resource status is '${resource.status}'` }, 400);
  }

  // Proxy to CF D1 HTTP API
  const d1Url = `https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${resource.cfResourceId}/query`;
  const d1Res = await fetch(d1Url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql: body.sql, params: body.params ?? [] }),
  });

  const d1Data = (await d1Res.json()) as any;
  if (!d1Data.success) {
    return c.json(
      {
        error: "query_failed",
        message: d1Data.errors?.[0]?.message ?? "Query failed",
        errors: d1Data.errors,
      },
      400,
    );
  }

  // D1 API returns result[0] for single queries
  const result = d1Data.result?.[0] ?? d1Data.result;
  return c.json({
    columns: result?.results?.length > 0 ? Object.keys(result.results[0]) : [],
    rows: result?.results ?? [],
    meta: {
      changes: result?.meta?.changes ?? 0,
      duration: result?.meta?.duration ?? 0,
      rows_read: result?.meta?.rows_read ?? 0,
      rows_written: result?.meta?.rows_written ?? 0,
    },
  });
});

/**
 * GET /resources/:id/metrics — fetch usage metrics from Cloudflare.
 * D1: database size + table count via D1 info API.
 * R2: object count via R2 bucket listing.
 * KV: key count via KV list API.
 */
resources.get("/:id/metrics", requirePermission("project:read"), async (c) => {
  const teamId = c.get("teamId");
  const id = c.req.param("id");

  const resource = await c.env.DB.prepare(
    `SELECT kind, cfResourceId, cfResourceType, status FROM resource WHERE id = ? AND teamId = ?`,
  )
    .bind(id, teamId)
    .first<{
      kind: string;
      cfResourceId: string | null;
      cfResourceType: string | null;
      status: string;
    }>();

  if (!resource) return c.json({ error: "not_found" }, 404);
  if (!resource.cfResourceId || resource.status !== "active") {
    return c.json({ error: "not_provisioned" }, 400);
  }

  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
  const token = c.env.CLOUDFLARE_API_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    switch (resource.cfResourceType) {
      case "d1": {
        // D1 database info
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${resource.cfResourceId}`,
          { headers },
        );
        const data = (await res.json()) as any;
        if (!data.success) throw new Error(data.errors?.[0]?.message ?? "D1 info failed");
        return c.json({
          kind: "database",
          size: data.result?.file_size ?? null,
          tables: data.result?.num_tables ?? null,
          version: data.result?.version ?? null,
        });
      }
      case "r2": {
        // R2 object count (list first page only for speed)
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${resource.cfResourceId}/objects?per_page=1`,
          { headers },
        );
        const data = (await res.json()) as any;
        // R2 list doesn't return total count directly — use truncated + count as signal
        const objects = data.result ?? [];
        const truncated = data.result_info?.truncated ?? false;
        return c.json({
          kind: "storage",
          objects: truncated ? "1000+" : objects.length,
          truncated,
        });
      }
      case "kv": {
        // KV key count (list first page)
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${resource.cfResourceId}/keys?per_page=1&limit=1`,
          { headers },
        );
        const data = (await res.json()) as any;
        const count = data.result_info?.count ?? data.result?.length ?? 0;
        return c.json({
          kind: "cache",
          keys: count,
        });
      }
      default:
        return c.json({
          kind: resource.kind,
          message: "Metrics not available for this resource type",
        });
    }
  } catch (err) {
    return c.json(
      {
        error: "metrics_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
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
  return env.DB.prepare(`SELECT id FROM project WHERE slug = ? AND organizationId = ?`)
    .bind(slug, teamId)
    .first<{ id: string }>();
}

resourceBindings.get("/:slug/bindings", requirePermission("project:read"), async (c) => {
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
});

resourceBindings.post("/:slug/bindings", requirePermission("project:create"), async (c) => {
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
        message: "bindingName required and must match /^[A-Z][A-Z0-9_]{0,62}$/ — ENV var shape",
      },
      400,
    );
  }

  // Insert only while the resource is live, in one statement: a separate
  // check could pass just before a concurrent delete marks it deleted and
  // queues its Cloudflare resource for teardown.
  const now = Date.now();
  try {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
       SELECT ?, ?, id, ? FROM resource WHERE id = ? AND teamId = ? AND status != 'deleted'`,
    )
      .bind(project.id, body.bindingName, now, body.resourceId, teamId)
      .run();
    if (!inserted.meta.changes) return c.json({ error: "not_found", message: "resource" }, 404);
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
});

resourceBindings.delete("/:slug/bindings/:name", requirePermission("project:create"), async (c) => {
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
});
