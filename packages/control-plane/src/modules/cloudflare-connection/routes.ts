/**
 * "Connect Cloudflare" routes.
 *
 *   GET    /integrations/cloudflare            the team's connection, if any
 *   POST   /integrations/cloudflare/authorize  start: returns the consent URL
 *   POST   /integrations/cloudflare/verify     get a token (refreshing it if due) and call Cloudflare
 *   DELETE /integrations/cloudflare            disconnect (and revoke at Cloudflare)
 *   GET    /oauth/cloudflare/callback          Cloudflare redirects the browser here
 *
 * Tokens live in the team's CloudflareGrant Durable Object (grant-object.ts);
 * these routes only talk to it.
 *
 * The first four run behind tenantMiddleware and are dashboard-only: an API
 * key cannot attach or detach an external account. The callback has no team
 * header (it is a top-level redirect from dash.cloudflare.com), so it is a
 * separate mount; it authenticates by the single-use state AND the session
 * cookie of the user who started the request (SameSite=Lax cookies ride on a
 * top-level GET navigation).
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser, TenantContext } from "../tenant/types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { createAuth } from "../tenant/auth.js";
import { requirePermission, roleGrants } from "../tenant/permissions.js";
import { isApiKeyRequest, markGuard, publicRoute } from "../tenant/scope-guard.js";
import { grantClient, type TokenResult } from "./grant-object.js";
import { exchangeCode, listAccounts, type CloudflareAccount } from "./oauth.js";
import {
  consumeState,
  createAuthorizationRequest,
  dashboardUrl,
  getConnectionStatus,
  oauthConfig,
  safeReturnTo,
} from "./store.js";

// The dashboard's existing settings page (apps/dashboard has no integrations
// route yet). A flow started with a returnTo goes back there instead.
const DEFAULT_RETURN_TO = "/settings";

/** Guard: dashboard sessions only — attaching an external account takes a person at a browser. */
const dashboardOnly = markGuard(
  (async (c: Context, next) => {
    if (!isApiKeyRequest(c)) return next();
    return c.json(
      {
        error: "api_key_not_allowed",
        message: "API keys cannot manage the Cloudflare connection; use the dashboard",
      },
      403,
    );
  }) as MiddlewareHandler,
  { kind: "session-only" },
);

function notConfigured(c: Context) {
  return c.json(
    {
      error: "not_configured",
      message: "This Creek instance has no Cloudflare OAuth client configured",
    },
    503,
  );
}

// --- Team-scoped management (behind tenantMiddleware) ---

type ManageEnv = {
  Bindings: Env;
  Variables: TenantContext & { auditCtx: AuditRequestContext };
};

export const cloudflareConnection = new Hono<ManageEnv>();

cloudflareConnection.get("/", dashboardOnly, requirePermission("project:read"), async (c) => {
  const configured = oauthConfig(c.env) !== null;
  const status = await getConnectionStatus(c.env.DB, c.get("teamId"));
  return c.json(status ? { configured, ...status } : { configured, connected: false });
});

cloudflareConnection.post(
  "/authorize",
  dashboardOnly,
  requirePermission("domain:manage"),
  async (c) => {
    const config = oauthConfig(c.env);
    if (!config) return notConfigured(c);
    if (!c.env.ENCRYPTION_KEY) {
      return c.json({ error: "not_configured", message: "ENCRYPTION_KEY is not configured" }, 503);
    }

    const body = (await c.req.json().catch(() => ({}))) as { returnTo?: unknown };
    const url = await createAuthorizationRequest(c.env, config, {
      teamId: c.get("teamId"),
      userId: c.get("user").id,
      returnTo: safeReturnTo(body.returnTo),
    });
    return c.json({ url });
  },
);

const TOKEN_ERROR_STATUS = {
  not_connected: 404,
  reauth_required: 409,
  not_configured: 503,
  upstream_error: 502,
} as const;

/**
 * Prove the grant works end to end: get a token (refreshing it when due)
 * and list the accounts it reaches. The dashboard's "test connection".
 */
cloudflareConnection.post(
  "/verify",
  dashboardOnly,
  requirePermission("project:read"),
  async (c) => {
    const result: TokenResult = await grantClient(c.env, c.get("teamId")).token();
    if (!result.ok) {
      return c.json(
        { error: result.error, message: result.message },
        TOKEN_ERROR_STATUS[result.error],
      );
    }
    try {
      const accounts = await listAccounts(result.accessToken);
      return c.json({ ok: true, accounts });
    } catch (err) {
      return c.json({ error: "upstream_error", message: String(err) }, 502);
    }
  },
);

cloudflareConnection.delete("/", dashboardOnly, requirePermission("domain:manage"), async (c) => {
  const teamId = c.get("teamId");
  // Revoking the refresh token ends the whole grant at Cloudflare; the user
  // can also see and revoke it under their Cloudflare profile.
  const { existed, revoked } = await grantClient(c.env, teamId).disconnect();
  if (!existed) return c.json({ error: "not_found", message: "No Cloudflare connection" }, 404);

  await recordAudit(
    c.env.DB,
    c.get("user"),
    teamId,
    {
      action: "integration.cloudflare.disconnect",
      resourceType: "integration",
      resourceId: "cloudflare",
      metadata: { revoked },
    },
    c.get("auditCtx"),
  );
  return c.json({ ok: true, revoked });
});

// --- OAuth callback (no tenant middleware) ---

type CallbackEnv = { Bindings: Env; Variables: { auditCtx: AuditRequestContext } };

export const cloudflareOAuthCallback = new Hono<CallbackEnv>();

function backToDashboard(
  c: Context<CallbackEnv>,
  returnTo: string | null,
  result: { ok: true } | { error: string },
) {
  const url = new URL(returnTo ?? DEFAULT_RETURN_TO, dashboardUrl(c.env));
  if ("ok" in result) url.searchParams.set("cloudflare", "connected");
  else url.searchParams.set("cloudflare_error", result.error);
  return c.redirect(url.toString(), 302);
}

cloudflareOAuthCallback.get("/callback", publicRoute, async (c) => {
  const config = oauthConfig(c.env);
  if (!config) return notConfigured(c);

  const stateParam = c.req.query("state");
  if (!stateParam) return backToDashboard(c, null, { error: "invalid_state" });

  const pending = await consumeState(c.env.DB, stateParam);
  if (!pending) return backToDashboard(c, null, { error: "invalid_state" });
  const returnTo = safeReturnTo(pending.returnTo);
  if (pending.expiresAt < Date.now()) return backToDashboard(c, returnTo, { error: "expired" });

  // The browser finishing the flow must belong to the user who started it.
  // Without this, a consent link sent to someone else would attach *their*
  // Cloudflare account to the sender's team.
  if (isApiKeyRequest(c)) return backToDashboard(c, returnTo, { error: "session_mismatch" });
  const session = await createAuth(c.env)
    .api.getSession({ headers: c.req.raw.headers })
    .catch(() => null);
  if (!session?.user || session.user.id !== pending.userId) {
    return backToDashboard(c, returnTo, { error: "session_mismatch" });
  }

  // Re-check the role: it may have changed during the consent screen.
  const member = await c.env.DB.prepare(
    "SELECT role FROM member WHERE organizationId = ? AND userId = ?",
  )
    .bind(pending.teamId, pending.userId)
    .first<{ role: string }>();
  if (!roleGrants(member?.role, "domain:manage")) {
    return backToDashboard(c, returnTo, { error: "forbidden" });
  }

  // The user pressed "Deny" (or Cloudflare refused the request).
  const oauthError = c.req.query("error");
  if (oauthError) {
    return backToDashboard(c, returnTo, {
      error: oauthError === "access_denied" ? "denied" : "authorization_failed",
    });
  }
  const code = c.req.query("code");
  if (!code) return backToDashboard(c, returnTo, { error: "authorization_failed" });

  let tokens;
  try {
    tokens = await exchangeCode(config, code, pending.codeVerifier);
  } catch (err) {
    console.error("[cloudflare-oauth] code exchange failed:", err);
    return backToDashboard(c, returnTo, { error: "token_exchange_failed" });
  }

  // Name the accounts the user picked. A failure here is not fatal: the grant
  // is good, and the list can be re-read later.
  let accounts: CloudflareAccount[] = [];
  try {
    accounts = await listAccounts(tokens.accessToken);
  } catch (err) {
    console.error("[cloudflare-oauth] listing accounts failed:", err);
  }

  await grantClient(c.env, pending.teamId).connect({
    teamId: pending.teamId,
    userId: pending.userId,
    tokens,
    accounts,
  });

  const user: AuthUser = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: ((session.user as Record<string, unknown>).role as string | null) ?? null,
    activeOrganizationId: null,
  };
  await recordAudit(
    c.env.DB,
    user,
    pending.teamId,
    {
      action: "integration.cloudflare.connect",
      resourceType: "integration",
      resourceId: "cloudflare",
      metadata: { accountIds: accounts.map((a) => a.id), scopes: tokens.scopes },
    },
    c.get("auditCtx"),
  );

  return backToDashboard(c, returnTo, { ok: true });
});
