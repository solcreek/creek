import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit, recordAuditOrThrow } from "../audit/service.js";
import { createAuth } from "../tenant/auth.js";
import { loadApiKeyGrant, type ApiKeyGrant } from "../tenant/api-key-grant.js";
import { resolveTeam } from "../tenant/resolve.js";
import { apiKeySelfRoute, isApiKeyRequest, sessionOnlyRoute } from "../tenant/scope-guard.js";
import {
  describeKey,
  discardKey,
  findMemberTeam,
  listKeys,
  mintScopedKey,
  mintedKeyView,
  parseCreateKeyBody,
  revokeKey,
  scopesBeyondRole,
  scopesForRole,
  type KeyAuthApi,
  type KeyView,
} from "./service.js";
import { MAX_ACTIVE_KEYS, countActiveKeys, keyLimitResponse } from "./cap.js";

/**
 * API key management.
 *
 *   GET    /api-keys/self   — a key reads itself (any key; no scope needed)
 *   DELETE /api-keys/self   — a key revokes itself
 *   POST   /api-keys        — a signed-in user mints a scoped key (session only;
 *                              at most MAX_ACTIVE_KEYS per user, see cap.ts)
 *   GET    /api-keys        — a signed-in user lists their keys (session only)
 *   DELETE /api-keys/:id    — a signed-in user revokes one of their keys (session only)
 *
 * No route here takes a team from x-creek-team, and none needs a scope: a
 * key can only act on itself, and everything else is for sessions.
 */

type ApiKeysEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    apiKeyGrant?: ApiKeyGrant;
    sessionImpersonated?: boolean;
    auditCtx: AuditRequestContext;
  };
};

/**
 * Authenticate a key-management request: a dashboard session or an API key.
 * Unlike tenantMiddleware it resolves no team, and it lets a key whose
 * scopes are unreadable (or whose owner left its team) through: such a key
 * can still read and revoke itself, and the session-only guard refuses every
 * key on every other route here.
 */
export const apiKeysAuth = createMiddleware<ApiKeysEnv>(async (c, next) => {
  const auth = createAuth(c.env);
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    // No cookie cache: minting a key must see a signed-out session as gone.
    session = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    });
  } catch (err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status !== 401 && status !== 403) throw err;
    session = null;
  }
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }

  if (isApiKeyRequest(c)) {
    const grant = await loadApiKeyGrant(c.env.DB, session.session.id, session.user.id);
    if (!grant) {
      return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
    }
    c.set("apiKeyGrant", grant);
  } else {
    c.set("sessionImpersonated", Boolean(session.session.impersonatedBy));
  }

  c.set("user", {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: (session.user.role as string | null) ?? null,
    activeOrganizationId: (session.session.activeOrganizationId as string | null) ?? null,
  });
  return next();
});

const apiKeys = new Hono<ApiKeysEnv>();

/** The team an audit entry for a key goes under: its pinned team, else the owner's first team. */
async function auditTeamFor(db: D1Database, userId: string, key: KeyView): Promise<string | null> {
  if (key.team) return key.team.id;
  const team = await resolveTeam(db, userId, undefined, null);
  return team.ok ? team.team.id : null;
}

/**
 * Audit a revocation. Best-effort: the key is already deleted, and revoking
 * is the safe direction, so a failed audit (or team lookup) is logged and
 * never turns a completed revocation into an error.
 */
async function auditRevoke(
  db: D1Database,
  auditCtx: AuditRequestContext,
  user: AuthUser,
  key: KeyView,
  via: "session" | "self",
) {
  try {
    await auditRevokeOrThrow(db, auditCtx, user, key, via);
  } catch (err) {
    console.error(`[api-keys] audit of key ${key.id} revocation failed:`, err);
  }
}

async function auditRevokeOrThrow(
  db: D1Database,
  auditCtx: AuditRequestContext,
  user: AuthUser,
  key: KeyView,
  via: "session" | "self",
) {
  const teamId = await auditTeamFor(db, user.id, key);
  if (!teamId) return;
  await recordAudit(
    db,
    user,
    teamId,
    {
      action: "api_key.revoke",
      resourceType: "api_key",
      resourceId: key.id,
      metadata: { name: key.name, legacy: key.legacy, scopes: key.scopes, via },
    },
    auditCtx,
  );
}

// --- The key making the request ---------------------------------------------
// Registered before /:id so that /self is never read as a key id.

apiKeys.get("/self", apiKeySelfRoute, async (c) => {
  const grant = c.get("apiKeyGrant")!;
  const self = await describeKey(c.env.DB, grant.keyId, c.get("user").id);
  if (!self) {
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }
  return c.json(self);
});

apiKeys.delete("/self", apiKeySelfRoute, async (c) => {
  const grant = c.get("apiKeyGrant")!;
  const user = c.get("user");
  const revoked = await revokeKey(c.env.DB, grant.keyId, user.id);
  if (!revoked) {
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }
  await auditRevoke(c.env.DB, c.get("auditCtx"), user, revoked, "self");
  return c.json({ revoked: true, id: revoked.id });
});

// --- Signed-in users ----------------------------------------------------------

apiKeys.post("/", sessionOnlyRoute, async (c) => {
  const user = c.get("user");
  if (c.get("sessionImpersonated")) {
    // A key would outlive the impersonation and keep the impersonator's access.
    return c.json(
      { error: "forbidden", message: "API keys cannot be created while impersonating a user" },
      403,
    );
  }
  // JSON only: a form or text/plain body is not a dashboard request.
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json(
      { error: "unsupported_media_type", message: "Send the body as application/json" },
      415,
    );
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "validation", message: "The body is not valid JSON" }, 400);
  }
  const parsed = parseCreateKeyBody(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, message: parsed.message, ...parsed.extra }, 400);
  }
  const input = parsed.value;

  const team = await findMemberTeam(c.env.DB, user.id, input.team);
  if (!team) {
    return c.json(
      { error: "team_not_found", message: "Team not found or you are not a member" },
      404,
    );
  }

  // A key never holds more than its creator's role allows today.
  const beyond = scopesBeyondRole(team.role, input.scopes);
  if (beyond.length > 0) {
    return c.json(
      {
        error: "scope_exceeds_role",
        message: `Your role in ${team.slug} (${team.role}) does not allow: ${beyond.join(", ")}`,
        scopes: beyond,
        role: team.role,
        allowedScopes: scopesForRole(team.role),
      },
      403,
    );
  }

  // The per-user cap, before anything is minted (see cap.ts).
  const before = await countActiveKeys(c.env.DB, user.id);
  if (before >= MAX_ACTIVE_KEYS) return keyLimitResponse(c, before);

  let minted: Awaited<ReturnType<typeof mintScopedKey>>;
  try {
    minted = await mintScopedKey(createAuth(c.env) as KeyAuthApi, c.env.DB, {
      userId: user.id,
      teamId: team.id,
      name: input.name,
      scopes: input.scopes,
      expiresIn: input.expiresIn,
    });
  } catch (err) {
    // The detail (possibly a database error) goes to the log, not the caller.
    console.error("[api-keys] create failed:", err);
    return c.json(
      { error: "key_create_failed", message: "API key creation failed; no key was created" },
      500,
    );
  }

  // The cap again, now that this key's row exists: a mint that raced past
  // the first check deletes its own key (by id) and is refused, so the cap
  // is never exceeded. If the count cannot be read, the key goes too.
  let after: number;
  try {
    after = await countActiveKeys(c.env.DB, user.id);
  } catch (err) {
    console.error(`[api-keys] cap check after creating key ${minted.id} failed:`, err);
    await discardKey(c.env.DB, minted.id, "the key cap could not be checked");
    return c.json(
      { error: "key_create_failed", message: "API key creation failed; no key was created" },
      500,
    );
  }
  if (after > MAX_ACTIVE_KEYS) {
    await discardKey(c.env.DB, minted.id, "a concurrent mint took the last slot under the cap");
    return keyLimitResponse(c, after - 1);
  }

  // From here a live key exists. Build the response from the verified row
  // and the team already resolved (no further database reads); if that
  // still fails, the key is deleted rather than left live without its
  // secret ever reaching anyone.
  let response: Record<string, unknown>;
  let view: ReturnType<typeof mintedKeyView>;
  try {
    view = mintedKeyView(minted.row, team);
    response = {
      key: minted.key,
      id: view.id,
      name: view.name,
      start: view.start,
      prefix: view.prefix,
      team: { id: team.id, slug: team.slug },
      scopes: view.scopes,
      preset: input.preset,
      effectiveScopes: view.effectiveScopes,
      expiresAt: view.expiresAt,
      createdAt: view.createdAt,
    };
  } catch (err) {
    console.error("[api-keys] building the create response failed:", err);
    await discardKey(c.env.DB, minted.id, "the create response could not be built");
    return c.json(
      { error: "key_create_failed", message: "API key creation failed; no key was created" },
      500,
    );
  }

  // No key may exist without its creation audit: write it before the
  // secret goes out, and if it cannot be written, delete the key and answer
  // 500. Should that delete fail too, it is logged as CRITICAL; the key's
  // secret was never returned, so nobody can use it.
  try {
    await recordAuditOrThrow(
      c.env.DB,
      user,
      team.id,
      {
        action: "api_key.create",
        resourceType: "api_key",
        resourceId: minted.id,
        metadata: {
          name: input.name,
          scopes: view.scopes,
          preset: input.preset,
          expiresAt: view.expiresAt,
        },
      },
      c.get("auditCtx"),
    );
  } catch (err) {
    console.error(`[api-keys] audit of key ${minted.id} creation failed:`, err);
    await discardKey(c.env.DB, minted.id, "its creation audit could not be written");
    return c.json(
      { error: "key_create_failed", message: "API key creation failed; no key was created" },
      500,
    );
  }

  // The secret is in this response and nowhere else.
  c.header("Cache-Control", "no-store");
  return c.json(response, 201);
});

apiKeys.get("/", sessionOnlyRoute, async (c) => {
  const user = c.get("user");
  const teamParam = c.req.query("team");
  let teamId: string | null = null;
  if (teamParam) {
    const team = await findMemberTeam(c.env.DB, user.id, teamParam);
    if (!team) {
      return c.json(
        { error: "team_not_found", message: "Team not found or you are not a member" },
        404,
      );
    }
    teamId = team.id;
  }
  return c.json({ keys: await listKeys(c.env.DB, user.id, teamId) });
});

apiKeys.delete("/:id", sessionOnlyRoute, async (c) => {
  const user = c.get("user");
  const revoked = await revokeKey(c.env.DB, c.req.param("id"), user.id);
  if (!revoked) {
    return c.json({ error: "not_found", message: "API key not found" }, 404);
  }
  await auditRevoke(c.env.DB, c.get("auditCtx"), user, revoked, "session");
  return c.json({ revoked: true, id: revoked.id });
});

export { apiKeys };
