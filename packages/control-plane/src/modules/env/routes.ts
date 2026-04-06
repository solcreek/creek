import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { encrypt, mask } from "./crypto.js";

type EnvVarEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; memberRole?: string; auditCtx: AuditRequestContext };
};

const envVars = new Hono<EnvVarEnv>();

// List env vars for a project (values masked)
envVars.get("/:projectId/env", async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const rows = await c.env.DB.prepare(
    "SELECT key, encryptedValue FROM environment_variable WHERE projectId = ? ORDER BY key ASC",
  )
    .bind(project.id)
    .all<{ key: string; encryptedValue: string }>();

  // Return keys with masked values — never expose encrypted blobs
  const vars = rows.results.map((row) => ({
    key: row.key,
    value: mask(row.key), // mask the key name as hint, actual value hidden
  }));

  return c.json(vars);
});

// Set an env var (create or update)
envVars.post("/:projectId/env", requirePermission("envvar:manage"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const body = await c.req.json<{ key: string; value: string }>();

  if (!body.key || typeof body.key !== "string") {
    return c.json({ error: "validation", message: "key is required" }, 400);
  }
  if (!body.value || typeof body.value !== "string") {
    return c.json({ error: "validation", message: "value is required" }, 400);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(body.key)) {
    return c.json(
      { error: "validation", message: "Key must be uppercase alphanumeric with underscores (e.g. DATABASE_URL)" },
      400,
    );
  }

  const encryptionKey = c.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    return c.json({ error: "config_error", message: "ENCRYPTION_KEY not configured" }, 500);
  }

  const encryptedValue = await encrypt(body.value, encryptionKey);

  // Upsert: INSERT OR REPLACE on composite PK (projectId, key)
  await c.env.DB.prepare(
    `INSERT INTO environment_variable (projectId, key, encryptedValue)
     VALUES (?, ?, ?)
     ON CONFLICT (projectId, key) DO UPDATE SET encryptedValue = excluded.encryptedValue`,
  )
    .bind(project.id, body.key, encryptedValue)
    .run();

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "envvar.set",
    resourceType: "envvar",
    resourceId: projectId,
    metadata: { key: body.key },
  }, c.get("auditCtx"));

  return c.json({ ok: true, key: body.key }, 201);
});

// Delete an env var
envVars.delete("/:projectId/env/:key", requirePermission("envvar:manage"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");
  const key = c.req.param("key");

  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM environment_variable WHERE projectId = ? AND key = ?",
  )
    .bind(project.id, key)
    .run();

  if (!result.meta.changes) {
    return c.json({ error: "not_found", message: `Environment variable '${key}' not found` }, 404);
  }

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "envvar.delete",
    resourceType: "envvar",
    resourceId: projectId,
    metadata: { key },
  }, c.get("auditCtx"));

  return c.json({ ok: true });
});

export { envVars };
