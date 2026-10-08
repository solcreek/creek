import { createMiddleware } from "hono/factory";
import type { Env } from "../../types.js";
import type { AuthUser, TenantContext } from "./types.js";
import { createAuth } from "./auth.js";
import { resolveTeam } from "./resolve.js";
import { loadApiKeyGrant } from "./api-key-grant.js";
import { isApiKeyRequest } from "./scope-guard.js";

// TenantContext's memberRole is optional at the type level (see types.ts) even
// though this middleware always sets it before calling next() on its success
// path — this keeps the type consistent with the rest of the module, where
// downstream consumers like requirePermission must keep failing closed.
type TenantEnv = {
  Bindings: Env;
  Variables: TenantContext;
};

/**
 * Combined tenant middleware: resolves user identity + team context in one pass.
 *
 * Auth: session cookie (dashboard) or API key header (CLI/CI).
 * Team resolution is delegated to resolveTeam() — a pure function testable without Better Auth.
 */
export const tenantMiddleware = createMiddleware<TenantEnv>(async (c, next) => {
  const auth = createAuth(c.env);

  // --- Resolve user identity ---
  // The api-key plugin throws (rather than returning null) for a key that is
  // invalid, disabled or expired: that is an authentication failure too.
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    // Better Auth's APIError carries the HTTP status; anything else (a D1
    // outage) is a real error, not a bad credential.
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status !== 401 && status !== 403) throw err;
    session = null;
  }

  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }

  // --- API key grant ---
  // An API-key session's id is the apikey row id. Look it up on every
  // request so a key's scopes (and its revocation) apply immediately.
  const grant = await loadApiKeyGrant(c.env.DB, session.session.id, session.user.id);
  if (isApiKeyRequest(c) && !grant) {
    // The header is there but the session isn't that key's — refuse rather
    // than fall back to whatever else authenticated the request.
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }
  if (grant?.kind === "invalid") {
    return c.json(
      { error: "invalid_key_scopes", message: "This API key's scopes are unreadable" },
      403,
    );
  }
  if (grant) c.set("apiKeyGrant", grant);

  const user: AuthUser = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: ((session.user as Record<string, unknown>).role as string | null) ?? null,
    activeOrganizationId:
      ((session.session as Record<string, unknown>).activeOrganizationId as string | null) ?? null,
  };

  c.set("user", user);

  // --- Resolve team context ---
  // A scoped key is pinned to one team: resolve that team (re-checking the
  // owner's membership) and refuse any other, whatever x-creek-team says.
  const pinnedTeamId = grant?.kind === "scoped" ? grant.teamId : null;
  const result = await resolveTeam(
    c.env.DB,
    user.id,
    c.req.header("x-creek-team"),
    pinnedTeamId ?? user.activeOrganizationId,
  );

  if (pinnedTeamId && (!result.ok || result.team.id !== pinnedTeamId)) {
    return c.json(
      {
        error: "team_mismatch",
        message:
          "This API key is limited to one team, and the request is for another team or its owner is no longer a member",
      },
      403,
    );
  }

  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return c.json({ error: result.error, message: result.message }, status);
  }

  c.set("teamId", result.team.id);
  c.set("teamSlug", result.team.slug);
  c.set("memberRole", result.team.role);
  return next();
});
