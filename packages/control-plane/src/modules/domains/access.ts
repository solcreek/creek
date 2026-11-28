import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { resolveProject } from "../tenant/resolve-project.js";
import { requireScopes } from "../tenant/scope-guard.js";

/**
 * Cloudflare Access protection for a project.
 *
 * The customer puts their custom domain behind an Access application in their
 * own Cloudflare account and gives Creek the team domain and the application's
 * AUD tag. The dispatch worker (packages/dispatch-worker/src/access.ts) then
 * serves the project, on every hostname, only to requests carrying a token
 * from that team for that application. The validation here mirrors the
 * worker's, which re-checks every value and refuses anything malformed.
 */

type AccessEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    teamId: string;
    teamSlug: string;
    memberRole?: string;
    auditCtx: AuditRequestContext;
  };
};

export const projectAccess = new Hono<AccessEnv>();

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD = /^[0-9a-f]{64}$/;
export const MAX_BYPASS_PATHS = 20;
const CERTS_TIMEOUT_MS = 5 * 1000;

/** `https://Acme.cloudflareaccess.com/` and `acme` both mean acme.cloudflareaccess.com. */
export function normalizeTeamDomain(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (v && !v.includes(".")) v = `${v}.cloudflareaccess.com`;
  return v;
}

/** Same rule as the dispatch worker's isBypassPath. */
export function isBypassPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/") || value.length > 256) return false;
  if (/[?#\s\\]/.test(value) || value.includes("//")) return false;
  const body = value.endsWith("/*") ? value.slice(0, -2) : value;
  if (body === "" || body === "/") return false;
  return !body.includes("*") && !body.includes("/../") && !body.endsWith("/..");
}

type Parsed =
  | { ok: true; teamDomain: string; aud: string; bypassPaths: string[] }
  | { ok: false; message: string };

export function parseAccessBody(body: unknown): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Expected a JSON object with teamDomain and aud" };
  }
  const { teamDomain, aud, bypassPaths } = body as Record<string, unknown>;
  if (typeof teamDomain !== "string" || !TEAM_DOMAIN.test(normalizeTeamDomain(teamDomain))) {
    return {
      ok: false,
      message: "teamDomain must be your Zero Trust team domain, <team>.cloudflareaccess.com",
    };
  }
  if (typeof aud !== "string" || !AUD.test(aud.trim().toLowerCase())) {
    return {
      ok: false,
      message:
        "aud must be the Access application's Application Audience (AUD) tag: 64 hex characters",
    };
  }
  let paths: string[] = [];
  if (bypassPaths !== undefined && bypassPaths !== null) {
    if (!Array.isArray(bypassPaths) || bypassPaths.length > MAX_BYPASS_PATHS) {
      return {
        ok: false,
        message: `bypassPaths must be a list of at most ${MAX_BYPASS_PATHS} paths`,
      };
    }
    const bad = bypassPaths.find((p) => !isBypassPath(p));
    if (bad !== undefined) {
      return {
        ok: false,
        message: `Invalid bypass path ${JSON.stringify(bad)}: use an absolute path prefix such as /health or /api/webhooks/*; / alone would bypass the whole site`,
      };
    }
    paths = [...new Set(bypassPaths as string[])];
  }
  return {
    ok: true,
    teamDomain: normalizeTeamDomain(teamDomain),
    aud: aud.trim().toLowerCase(),
    bypassPaths: paths,
  };
}

/**
 * Whether the team publishes signing keys. A typo'd team domain would lock the
 * project to tokens nobody can produce, so it is refused up front. (A wrong AUD
 * can't be checked from here: the application belongs to the customer's
 * account. It shows as 403s on the custom domain until corrected.)
 */
async function teamHasKeys(teamDomain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { keys?: unknown };
    return Array.isArray(body.keys) && body.keys.length > 0;
  } catch {
    return false;
  }
}

function isMissingAccessColumn(err: unknown): boolean {
  return /no such column.*access/i.test(err instanceof Error ? err.message : String(err));
}

function migrationPending(c: { json: (b: unknown, s: 503) => Response }) {
  return c.json(
    {
      error: "not_available",
      message: "Access protection isn't available yet: the database migration is pending",
    },
    503,
  );
}

interface AccessRow {
  accessTeamDomain: string | null;
  accessAud: string | null;
  accessBypassPaths: string | null;
}

function toStatus(row: AccessRow | null) {
  if (!row?.accessTeamDomain && !row?.accessAud) {
    return { protected: false as const };
  }
  let bypassPaths: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.accessBypassPaths ?? "[]");
    if (Array.isArray(parsed)) bypassPaths = parsed.filter(isBypassPath);
  } catch {
    // Shown as none; the worker treats it the same way.
  }
  return {
    protected: true as const,
    teamDomain: row.accessTeamDomain,
    aud: row.accessAud,
    bypassPaths,
  };
}

projectAccess.get(
  "/:projectId/access",
  requireScopes("domain:read"),
  requirePermission("project:read"),
  async (c) => {
    const project = await resolveProject(c.env.DB, c.req.param("projectId")!, c.get("teamId"));
    if (!project) return c.json({ error: "not_found", message: "Project not found" }, 404);
    try {
      const row = await c.env.DB.prepare(
        "SELECT accessTeamDomain, accessAud, accessBypassPaths FROM project WHERE id = ?",
      )
        .bind(project.id)
        .first<AccessRow>();
      return c.json(toStatus(row));
    } catch (err) {
      if (isMissingAccessColumn(err)) return migrationPending(c);
      throw err;
    }
  },
);

projectAccess.put(
  "/:projectId/access",
  requireScopes("domain:write"),
  requirePermission("domain:manage"),
  async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = parseAccessBody(body);
    if (!parsed.ok) return c.json({ error: "validation", message: parsed.message }, 400);

    const project = await resolveProject(c.env.DB, c.req.param("projectId")!, c.get("teamId"));
    if (!project) return c.json({ error: "not_found", message: "Project not found" }, 404);

    if (!(await teamHasKeys(parsed.teamDomain))) {
      return c.json(
        {
          error: "team_not_found",
          message: `${parsed.teamDomain} publishes no Access signing keys. Check the team domain under Zero Trust → Settings → Custom Pages.`,
        },
        400,
      );
    }

    try {
      await c.env.DB.prepare(
        `UPDATE project SET accessTeamDomain = ?, accessAud = ?, accessBypassPaths = ?, updatedAt = ?
         WHERE id = ?`,
      )
        .bind(
          parsed.teamDomain,
          parsed.aud,
          JSON.stringify(parsed.bypassPaths),
          Date.now(),
          project.id,
        )
        .run();
    } catch (err) {
      if (isMissingAccessColumn(err)) return migrationPending(c);
      throw err;
    }

    await recordAudit(
      c.env.DB,
      c.get("user"),
      c.get("teamId"),
      {
        action: "domain.access_update",
        resourceType: "project",
        resourceId: project.id,
        metadata: {
          teamDomain: parsed.teamDomain,
          aud: parsed.aud,
          bypassPaths: parsed.bypassPaths,
        },
      },
      c.get("auditCtx"),
    );

    return c.json({
      ok: true,
      protected: true,
      teamDomain: parsed.teamDomain,
      aud: parsed.aud,
      bypassPaths: parsed.bypassPaths,
    });
  },
);

projectAccess.delete(
  "/:projectId/access",
  requireScopes("domain:write"),
  requirePermission("domain:manage"),
  async (c) => {
    const project = await resolveProject(c.env.DB, c.req.param("projectId")!, c.get("teamId"));
    if (!project) return c.json({ error: "not_found", message: "Project not found" }, 404);
    try {
      await c.env.DB.prepare(
        `UPDATE project SET accessTeamDomain = NULL, accessAud = NULL, accessBypassPaths = NULL,
           updatedAt = ? WHERE id = ?`,
      )
        .bind(Date.now(), project.id)
        .run();
    } catch (err) {
      if (isMissingAccessColumn(err)) return migrationPending(c);
      throw err;
    }

    await recordAudit(
      c.env.DB,
      c.get("user"),
      c.get("teamId"),
      { action: "domain.access_remove", resourceType: "project", resourceId: project.id },
      c.get("auditCtx"),
    );

    return c.json({ ok: true, protected: false });
  },
);
