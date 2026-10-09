import type { Context, MiddlewareHandler, Next } from "hono";
import { matchedRoutes } from "hono/route";
import type { ApiKeyGrant } from "./api-key-grant.js";
import { roleGrants } from "./permissions.js";
import { SCOPES, type Scope } from "./scopes.js";

/**
 * Route guards for API key scopes.
 *
 * Every endpoint declares exactly what it needs by putting one guard in its
 * handler chain, before the handler:
 *
 *   requireScopes("env:write")              — the key must hold every scope
 *   requireAnyScope("deploy:preview", ...)  — at least one; the handler then
 *                                             narrows with assertScope()
 *   publicRoute / internalRoute             — no user auth on this route
 *   apiKeyAuthRouteGuard                    — Better Auth's own routes
 *   requirePlatformAdmin                    — platform operators only
 *
 * Guards only act on API-key requests. A dashboard session or a legacy key
 * (no scopes stored) passes through unchanged; role checks for those are
 * requirePermission()'s job, as before.
 *
 * Two independent checks keep an endpoint from shipping without a guard:
 * scope-coverage.test.ts walks app.routes, and apiKeyRouteGate refuses any
 * API-key request whose matched endpoint carries no guard.
 */

export type GuardInfo =
  | { kind: "scopes"; mode: "all" | "any"; scopes: readonly Scope[] }
  | { kind: "public" }
  | { kind: "internal" }
  | { kind: "auth-routes" }
  | { kind: "platform-admin" };

const GUARDS = new WeakMap<Function, GuardInfo>();

/** Hono wraps a sub-app's handler when the sub-app has its own onError. */
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

/** The guard a route handler is, if any. Sees through Hono's sub-app wrapper. */
export function guardInfo(handler: unknown): GuardInfo | undefined {
  let fn = handler as (Function & Record<string, unknown>) | undefined;
  for (let depth = 0; fn && depth < 4; depth++) {
    const info = GUARDS.get(fn);
    if (info) return info;
    fn = fn[COMPOSED_HANDLER] as (Function & Record<string, unknown>) | undefined;
  }
  return undefined;
}

export function markGuard<T extends Function>(fn: T, info: GuardInfo): T {
  GUARDS.set(fn, info);
  return fn;
}

/**
 * Whether the request authenticates with an API key. Same read as Better
 * Auth's api-key plugin (Headers.get("x-api-key"), truthy), so the two can't
 * disagree about which requests are key requests.
 */
export function isApiKeyRequest(c: Context): boolean {
  return Boolean(c.req.raw.headers.get("x-api-key"));
}

type GuardVariables = { apiKeyGrant?: ApiKeyGrant | null; memberRole?: string };
type GuardContext = Context<{ Variables: GuardVariables }>;

function forbidden(
  c: Context,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return c.json({ error, message, ...extra }, 403);
}

/**
 * Decide a scoped key's access to `required`. Returns a 403 response, or
 * null when the request may proceed. Non-key requests and legacy keys pass.
 */
function checkScopes(
  c: GuardContext,
  mode: "all" | "any",
  required: readonly Scope[],
): Response | null {
  if (!isApiKeyRequest(c)) return null;
  const grant = c.get("apiKeyGrant");
  // A key request whose grant was never loaded means the route runs without
  // tenantMiddleware in front of the guard — refuse rather than guess.
  if (!grant) {
    return forbidden(c, "scope_unresolved", "This route cannot authorize an API key");
  }
  if (grant.kind === "legacy") return null;
  if (grant.kind === "invalid") {
    return forbidden(c, "invalid_key_scopes", "This API key's scopes are unreadable");
  }

  const role = c.get("memberRole");
  const usable = (s: Scope) => grant.scopes.has(s) && roleGrants(role, SCOPES[s].rolePermission);
  const ok = mode === "all" ? required.every(usable) : required.some(usable);
  if (ok) return null;

  const held =
    mode === "all"
      ? required.every((s) => grant.scopes.has(s))
      : required.some((s) => grant.scopes.has(s));
  const extra = { required, requiredMode: mode, granted: [...grant.scopes].sort() };
  if (held) {
    // The key holds the scope, but its owner's team role no longer allows it.
    return forbidden(
      c,
      "insufficient_role",
      "The API key's owner no longer has a team role that allows this",
      extra,
    );
  }
  const what = mode === "all" ? required.join(", ") : `one of ${required.join(", ")}`;
  return forbidden(c, "insufficient_scope", `This API key lacks the scope: ${what}`, extra);
}

/** Guard: a scoped key must hold every listed scope. */
export function requireScopes(...scopes: Scope[]): MiddlewareHandler {
  if (scopes.length === 0) throw new Error("requireScopes needs at least one scope");
  const guard: MiddlewareHandler = async (c, next) =>
    checkScopes(c as GuardContext, "all", scopes) ?? next();
  return markGuard(guard, { kind: "scopes", mode: "all", scopes });
}

/**
 * Guard: a scoped key must hold at least one listed scope. For routes whose
 * exact scope depends on the request (preview vs production); the handler
 * must call assertScope() with the exact scope before any side effect.
 */
export function requireAnyScope(...scopes: Scope[]): MiddlewareHandler {
  if (scopes.length < 2) throw new Error("requireAnyScope needs at least two scopes");
  const guard: MiddlewareHandler = async (c, next) =>
    checkScopes(c as GuardContext, "any", scopes) ?? next();
  return markGuard(guard, { kind: "scopes", mode: "any", scopes });
}

/** In-handler check for one exact scope. Returns a 403 response, or null to proceed. */
export function assertScope(c: Context, scope: Scope): Response | null {
  return checkScopes(c as GuardContext, "all", [scope]);
}

/** The deploy scope a deployment on `branch` needs. No branch means production. */
export function deployScopeFor(branch: string | null | undefined, productionBranch: string): Scope {
  return !branch || branch === productionBranch ? "deploy:production" : "deploy:preview";
}

const passThrough = (): MiddlewareHandler => async (_c: Context, next: Next) => next();

/** Guard: the route takes no user authentication (it may verify something else, e.g. an HMAC). */
export const publicRoute = markGuard(passThrough(), { kind: "public" });

/** Guard: the route is for internal callers authenticated by INTERNAL_SECRET. */
export const internalRoute = markGuard(passThrough(), { kind: "internal" });

/** The only Better Auth endpoint an API key may call: CLI login/whoami read the session. */
const API_KEY_AUTH_ALLOWLIST = new Set(["GET /api/auth/get-session"]);

/**
 * Guard for /api/auth/*. Better Auth turns an x-api-key header into a full
 * session on every one of its endpoints, so without this a key could create
 * more keys or manage organizations. Keys get the session read only; the
 * match is exact, so path variants are refused rather than normalized.
 */
export const apiKeyAuthRouteGuard = markGuard(
  (async (c, next) => {
    if (!isApiKeyRequest(c)) return next();
    // The raw pathname, not c.req.path: Hono percent-decodes that one.
    const pathname = new URL(c.req.url).pathname;
    if (API_KEY_AUTH_ALLOWLIST.has(`${c.req.method} ${pathname}`)) return next();
    return forbidden(
      c,
      "api_key_not_allowed",
      "API keys cannot call this endpoint; sign in to the dashboard instead",
    );
  }) as MiddlewareHandler,
  { kind: "auth-routes" },
);

/**
 * Global middleware, registered before every route. An API-key request whose
 * matched endpoint has no guard is refused before any handler runs, so a
 * route added without a guard fails closed for keys instead of granting
 * whatever the key owner's role allows.
 */
export const apiKeyRouteGate: MiddlewareHandler = async (c, next) => {
  if (!isApiKeyRequest(c)) return next();
  const groups = new Map<string, unknown[]>();
  for (const route of matchedRoutes(c)) {
    if (route.method === "ALL") continue; // app.use() middleware, not an endpoint
    const key = `${route.method} ${route.path}`;
    const handlers = groups.get(key) ?? [];
    handlers.push(route.handler);
    groups.set(key, handlers);
  }
  for (const [route, handlers] of groups) {
    // The last handler is the endpoint; a guard must run before it.
    if (!handlers.slice(0, -1).some((h) => guardInfo(h))) {
      console.error(`[scope-guard] refused API key request: no guard on ${route}`);
      return forbidden(c, "route_not_scoped", "This endpoint does not accept API keys");
    }
  }
  return next();
};
