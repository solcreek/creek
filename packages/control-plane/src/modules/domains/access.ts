import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { resolveProject } from "../tenant/resolve-project.js";
import { requireScopes } from "../tenant/scope-guard.js";
import {
  ProvisionError,
  deleteCreated,
  parseManagedInput,
  provisionManagedAccess,
  readManaged,
  removeManagedApps,
  type ManagedAccess,
} from "./access-managed.js";

/**
 * Cloudflare Access protection for a project.
 *
 * The customer puts their custom domain behind an Access application in their
 * own Cloudflare account and gives Creek the team domain and the application's
 * AUD tag. The dispatch worker (packages/dispatch-worker/src/access.ts) then
 * serves the project, on every hostname, only to requests carrying a token
 * from that team for that application. The validation here mirrors the
 * worker's, which re-checks every value and refuses anything malformed.
 *
 * Two ways to set it up:
 *   PUT /:projectId/access          the customer made the application and
 *                                   hands Creek its team domain and AUD;
 *   PUT /:projectId/access/managed  Creek makes and keeps the applications in
 *                                   the team's connected Cloudflare account
 *                                   (access-managed.ts).
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
    return {
      ok: false,
      message: "Expected a JSON object with teamDomain and aud",
    };
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
  const paths = parseBypassPaths(bypassPaths);
  if (typeof paths === "string") return { ok: false, message: paths };
  return {
    ok: true,
    teamDomain: normalizeTeamDomain(teamDomain),
    aud: aud.trim().toLowerCase(),
    bypassPaths: paths,
  };
}

/** The bypass path list, de-duplicated, or the reason it is refused. */
export function parseBypassPaths(value: unknown): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BYPASS_PATHS) {
    return `bypassPaths must be a list of at most ${MAX_BYPASS_PATHS} paths`;
  }
  const bad = value.find((p) => !isBypassPath(p));
  if (bad !== undefined) {
    return `Invalid bypass path ${JSON.stringify(bad)}: use an absolute path prefix such as /health or /api/webhooks/*; / alone would bypass the whole site`;
  }
  return [...new Set(value as string[])];
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
  accessManaged: string | null;
}

function readRow(db: Env["DB"], projectId: string) {
  return db
    .prepare(
      "SELECT accessTeamDomain, accessAud, accessBypassPaths, accessManaged FROM project WHERE id = ?",
    )
    .bind(projectId)
    .first<AccessRow>();
}

/** What GET shows about a managed setup: the account, and who gets in. */
function managedView(m: ManagedAccess) {
  return {
    accountId: m.accountId,
    emails: m.emails,
    emailDomains: m.emailDomains,
    teamMembers: m.teamMembers,
  };
}

function toStatus(row: AccessRow | null) {
  if (!row?.accessTeamDomain && !row?.accessAud) {
    return { protected: false as const };
  }
  const managed = readManaged(row.accessManaged);
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
    managed: managed ? managedView(managed) : null,
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
      return c.json(toStatus(await readRow(c.env.DB, project.id)));
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

    let current: AccessRow | null;
    try {
      current = await readRow(c.env.DB, project.id);
    } catch (err) {
      if (isMissingAccessColumn(err)) return migrationPending(c);
      throw err;
    }
    // Overwriting would leave Creek's applications behind, unreachable.
    if (readManaged(current?.accessManaged)) {
      return c.json(
        {
          error: "managed_by_creek",
          message:
            "Creek manages this project's Access applications: change them with PUT /projects/:id/access/managed, or remove protection first",
        },
        409,
      );
    }

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
        `UPDATE project SET accessTeamDomain = ?, accessAud = ?, accessBypassPaths = ?,
           accessManaged = NULL, updatedAt = ?
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

/**
 * Creek makes (or updates) the Access applications in the team's connected
 * Cloudflare account, then protects the project with them.
 *
 * Body: { accountId?, emails?, emailDomains?, teamMembers?, bypassPaths? }.
 * accountId may be left out when the grant covers one account, or once set.
 * teamMembers adds the Creek team's members' emails as of this call.
 */
projectAccess.put(
  "/:projectId/access/managed",
  requireScopes("domain:write"),
  requirePermission("domain:manage"),
  async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "validation", message: "Expected a JSON object" }, 400);
    }
    const parsed = parseManagedInput(body as Record<string, unknown>);
    if (!parsed.ok) return c.json({ error: "validation", message: parsed.message }, 400);
    const bypassPaths = parseBypassPaths((body as Record<string, unknown>).bypassPaths);
    if (typeof bypassPaths === "string") {
      return c.json({ error: "validation", message: bypassPaths }, 400);
    }

    const teamId = c.get("teamId");
    const project = await resolveProject(c.env.DB, c.req.param("projectId")!, teamId);
    if (!project) return c.json({ error: "not_found", message: "Project not found" }, 404);

    let current: AccessRow | null;
    try {
      current = await readRow(c.env.DB, project.id);
    } catch (err) {
      if (isMissingAccessColumn(err)) return migrationPending(c);
      throw err;
    }

    let result;
    try {
      result = await provisionManagedAccess(c.env, {
        teamId,
        teamSlug: c.get("teamSlug"),
        project,
        previous: readManaged(current?.accessManaged),
        input: parsed.input,
        bypassPaths,
      });
    } catch (err) {
      if (err instanceof ProvisionError) {
        return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
      }
      throw err;
    }

    if (!TEAM_DOMAIN.test(result.teamDomain)) {
      await deleteCreated(result.token, result.managed.accountId, result.created);
      return c.json(
        {
          error: "cloudflare_unexpected",
          message: `Cloudflare reported the team domain ${JSON.stringify(result.teamDomain)}, which Creek cannot verify tokens from`,
        },
        502,
      );
    }

    try {
      await c.env.DB.prepare(
        `UPDATE project SET accessTeamDomain = ?, accessAud = ?, accessBypassPaths = ?,
           accessManaged = ?, updatedAt = ?
         WHERE id = ?`,
      )
        .bind(
          result.teamDomain,
          result.aud,
          JSON.stringify(bypassPaths),
          JSON.stringify(result.managed),
          Date.now(),
          project.id,
        )
        .run();
    } catch (err) {
      await deleteCreated(result.token, result.managed.accountId, result.created);
      throw err;
    }

    await recordAudit(
      c.env.DB,
      c.get("user"),
      teamId,
      {
        action: "domain.access_update",
        resourceType: "project",
        resourceId: project.id,
        metadata: {
          managed: true,
          accountId: result.managed.accountId,
          teamDomain: result.teamDomain,
          aud: result.aud,
          hostnames: result.hostnames,
          emails: result.managed.emails,
          emailDomains: result.managed.emailDomains,
          teamMembers: result.managed.teamMembers,
          bypassPaths,
        },
      },
      c.get("auditCtx"),
    );

    return c.json({
      ok: true,
      protected: true,
      teamDomain: result.teamDomain,
      aud: result.aud,
      bypassPaths,
      hostnames: result.hostnames,
      managed: managedView(result.managed),
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

    let current: AccessRow | null;
    try {
      current = await readRow(c.env.DB, project.id);
    } catch (err) {
      if (isMissingAccessColumn(err)) return migrationPending(c);
      throw err;
    }

    // Delete Creek's applications first. If that fails, protection still
    // comes off: the applications left behind keep the custom domain behind
    // Access (the safe side), and the answer names them for manual removal.
    const managed = readManaged(current?.accessManaged);
    const cleanup = managed ? await removeManagedApps(c.env, c.get("teamId"), managed) : null;

    await c.env.DB.prepare(
      `UPDATE project SET accessTeamDomain = NULL, accessAud = NULL, accessBypassPaths = NULL,
         accessManaged = NULL, updatedAt = ? WHERE id = ?`,
    )
      .bind(Date.now(), project.id)
      .run();

    await recordAudit(
      c.env.DB,
      c.get("user"),
      c.get("teamId"),
      {
        action: "domain.access_remove",
        resourceType: "project",
        resourceId: project.id,
        ...(managed
          ? {
              metadata: {
                managed: true,
                accountId: managed.accountId,
                cloudflareCleanup: cleanup?.ok ? "deleted" : "failed",
              },
            }
          : {}),
      },
      c.get("auditCtx"),
    );

    if (cleanup && !cleanup.ok) {
      return c.json({
        ok: true,
        protected: false,
        cloudflareCleanup: {
          ok: false,
          message: `Protection is off, but Creek could not delete its Access applications (${cleanup.message}). Delete them in Cloudflare Zero Trust → Access → Applications.`,
          accountId: managed!.accountId,
          appIds: cleanup.appIds,
        },
      });
    }
    return c.json({ ok: true, protected: false });
  },
);
