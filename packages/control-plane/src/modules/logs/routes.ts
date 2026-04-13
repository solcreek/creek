/**
 * Log query routes — read R2 ndjson archive + mint WS subscribe tokens.
 *
 *   GET /projects/:slug/logs            — list LogEntries with filters
 *   GET /projects/:slug/logs/ws-token   — token for `creek logs --follow`
 *
 * Tenant isolation:
 *   - teamSlug comes from c.get("teamSlug") (set by tenantMiddleware).
 *   - project slug from URL param, verified to belong to this team.
 *   - R2 prefix is server-derived as logs/{teamSlug}/{projectSlug}/.
 *     User input never touches the prefix; cross-tenant reads are
 *     structurally impossible (would need to forge teamSlug, which
 *     is set by signed session middleware).
 *
 * Permission: project:read — anyone who can see the project can see
 * its logs. Tighter scoping (e.g. logs:read split from project:read)
 * can be added later by extending the role table; the route
 * declaration is the only point that needs to change.
 */

import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import { requirePermission } from "../tenant/permissions.js";
import { parseQuery } from "./query.js";
import { readLogs } from "./r2-reader.js";
import { mintLogsWsToken } from "./ws-token.js";

type LogsEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string };
};

export const logs = new Hono<LogsEnv>();

logs.get("/:slug/logs", requirePermission("project:read"), async (c) => {
  const projectSlug = c.req.param("slug") ?? "";
  const teamSlug = c.get("teamSlug");
  const teamId = c.get("teamId");
  if (!projectSlug) return c.json({ error: "validation", message: "slug required" }, 400);

  // Confirm the project exists in this team. Without this check, a
  // user could probe for log existence across all projects with this
  // team slug — defence in depth even though the R2 prefix is also
  // team-scoped.
  const project = await c.env.DB.prepare(
    "SELECT slug FROM project WHERE slug = ? AND organizationId = ?",
  )
    .bind(projectSlug, teamId)
    .first<{ slug: string }>();
  if (!project) {
    return c.json({ error: "not_found", message: "Project not found in this team" }, 404);
  }

  if (!c.env.LOGS_BUCKET) {
    return c.json({ error: "logs_not_configured", message: "LOGS_BUCKET binding missing" }, 503);
  }

  const url = new URL(c.req.url);
  const query = parseQuery(url.searchParams, Date.now());
  const result = await readLogs({
    bucket: c.env.LOGS_BUCKET,
    team: teamSlug,
    project: projectSlug,
    query,
  });

  return c.json({
    entries: result.entries,
    truncated: result.truncated,
    query: {
      sinceMs: query.sinceMs,
      untilMs: query.untilMs,
      limit: query.limit,
    },
  });
});

logs.get("/:slug/logs/ws-token", requirePermission("project:read"), async (c) => {
  const projectSlug = c.req.param("slug") ?? "";
  const teamSlug = c.get("teamSlug");
  const teamId = c.get("teamId");
  if (!projectSlug) return c.json({ error: "validation", message: "slug required" }, 400);

  const project = await c.env.DB.prepare(
    "SELECT slug FROM project WHERE slug = ? AND organizationId = ?",
  )
    .bind(projectSlug, teamId)
    .first<{ slug: string }>();
  if (!project) {
    return c.json({ error: "not_found", message: "Project not found in this team" }, 404);
  }

  const minted = await mintLogsWsToken({
    masterKey: c.env.REALTIME_MASTER_KEY,
    team: teamSlug,
    project: projectSlug,
  });
  if (!minted) {
    return c.json({ error: "logs_realtime_disabled", message: "REALTIME_MASTER_KEY not set" }, 503);
  }

  const realtimeUrl = c.env.CREEK_REALTIME_URL ?? "https://rt.creek.dev";
  const wsUrl = `${realtimeUrl.replace(/^http/, "ws")}/${encodeURIComponent(minted.slug)}/rooms/logs/ws?token=${minted.token}`;

  return c.json({
    token: minted.token,
    expiresAt: minted.expiresAt,
    slug: minted.slug,
    wsUrl,
  });
});
