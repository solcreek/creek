import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { resolveProject } from "../tenant/resolve-project.js";
import { encrypt, mask } from "./crypto.js";
import { ENV_TARGETS, isEnvTarget } from "./targets.js";
import { requireScopes } from "../tenant/scope-guard.js";

type EnvVarEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    teamId: string;
    teamSlug: string;
    memberRole?: string;
    auditCtx: AuditRequestContext;
  };
};

const envVars = new Hono<EnvVarEnv>();

// List env vars for a project (values masked). One entry per key and target.
envVars.get("/:projectId/env", requireScopes("env:read"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");

  const project = await resolveProject(c.env.DB, projectId!, teamId);

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const rows = await c.env.DB.prepare(
    "SELECT key, target FROM environment_variable WHERE projectId = ? ORDER BY key ASC, target ASC",
  )
    .bind(project.id)
    .all<{ key: string; target: string }>();

  // Return keys with masked values — never expose encrypted blobs
  const vars = rows.results.map((row) => ({
    key: row.key,
    target: row.target,
    value: mask(row.key), // mask the key name as hint, actual value hidden
  }));

  return c.json(vars);
});

// Set an env var (create or update)
envVars.post(
  "/:projectId/env",
  requireScopes("env:write"),
  requirePermission("envvar:manage"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");

    const project = await resolveProject(c.env.DB, projectId!, teamId);

    if (!project) {
      return c.json({ error: "not_found", message: "Project not found" }, 404);
    }

    const body = await c.req.json<{ key: string; value: string; target?: unknown }>();
    const target = body.target ?? "all";
    if (!isEnvTarget(target)) {
      return c.json(
        { error: "validation", message: `target must be one of: ${ENV_TARGETS.join(", ")}` },
        400,
      );
    }

    if (!body.key || typeof body.key !== "string") {
      return c.json({ error: "validation", message: "key is required" }, 400);
    }
    if (!body.value || typeof body.value !== "string") {
      return c.json({ error: "validation", message: "value is required" }, 400);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(body.key)) {
      return c.json(
        {
          error: "validation",
          message: "Key must be uppercase alphanumeric with underscores (e.g. DATABASE_URL)",
        },
        400,
      );
    }

    const encryptionKey = c.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      return c.json({ error: "config_error", message: "ENCRYPTION_KEY not configured" }, 500);
    }

    const encryptedValue = await encrypt(body.value, encryptionKey);

    // Upsert on the composite PK (projectId, key, target)
    await c.env.DB.prepare(
      `INSERT INTO environment_variable (projectId, key, target, encryptedValue)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (projectId, key, target) DO UPDATE SET encryptedValue = excluded.encryptedValue`,
    )
      .bind(project.id, body.key, target, encryptedValue)
      .run();

    await recordAudit(
      c.env.DB,
      c.get("user"),
      c.get("teamId"),
      {
        action: "envvar.set",
        resourceType: "envvar",
        resourceId: projectId,
        metadata: { key: body.key, target },
      },
      c.get("auditCtx"),
    );

    return c.json({ ok: true, key: body.key, target }, 201);
  },
);

// Delete an env var: one target's value with ?target=, else every target's.
envVars.delete(
  "/:projectId/env/:key",
  requireScopes("env:write"),
  requirePermission("envvar:manage"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");
    const key = c.req.param("key");
    const target = c.req.query("target");
    if (target !== undefined && !isEnvTarget(target)) {
      return c.json(
        { error: "validation", message: `target must be one of: ${ENV_TARGETS.join(", ")}` },
        400,
      );
    }

    const project = await resolveProject(c.env.DB, projectId!, teamId);

    if (!project) {
      return c.json({ error: "not_found", message: "Project not found" }, 404);
    }

    const result = await (
      target
        ? c.env.DB.prepare(
            "DELETE FROM environment_variable WHERE projectId = ? AND key = ? AND target = ?",
          ).bind(project.id, key, target)
        : c.env.DB.prepare("DELETE FROM environment_variable WHERE projectId = ? AND key = ?").bind(
            project.id,
            key,
          )
    ).run();

    if (!result.meta.changes) {
      return c.json(
        {
          error: "not_found",
          message: `Environment variable '${key}'${target ? ` (${target})` : ""} not found`,
        },
        404,
      );
    }

    await recordAudit(
      c.env.DB,
      c.get("user"),
      c.get("teamId"),
      {
        action: "envvar.delete",
        resourceType: "envvar",
        resourceId: projectId,
        metadata: { key, target: target ?? "every target" },
      },
      c.get("auditCtx"),
    );

    return c.json({ ok: true, removed: result.meta.changes });
  },
);

export { envVars };
