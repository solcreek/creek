import { createMiddleware } from "hono/factory";
import type { Env } from "../../types.js";
import { createAuth } from "./auth.js";
import { loadApiKeyGrant } from "./api-key-grant.js";
import { isApiKeyRequest, markGuard } from "./scope-guard.js";

/**
 * Gate a route to platform operators: users whose Better Auth admin-plugin
 * role is "admin". This is the instance-wide role on the `user` row, not a
 * team role — it answers "who runs this Creek install", so team owners don't
 * pass it.
 *
 * Auth: session cookie or `x-api-key`, same as tenantMiddleware. No team is
 * resolved: platform routes are not team-scoped. A scoped API key is refused
 * here whatever its scopes: no scope grants platform administration. A
 * legacy key keeps its owner's access.
 */
export const requirePlatformAdmin = markGuard(
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    // Skip the 5-minute session cookie cache: it snapshots the user row, so a
    // granted or revoked admin role would otherwise lag by up to 5 minutes.
    let session: Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>;
    try {
      session = await createAuth(c.env).api.getSession({
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
      if (grant.kind === "invalid") {
        return c.json(
          { error: "invalid_key_scopes", message: "This API key's scopes are unreadable" },
          403,
        );
      }
      if (grant.kind !== "legacy") {
        return c.json(
          { error: "forbidden", message: "Scoped API keys cannot use platform admin endpoints" },
          403,
        );
      }
    }
    const role = (session.user as Record<string, unknown>).role;
    if (role !== "admin") {
      return c.json(
        { error: "forbidden", message: "This endpoint requires a platform admin account" },
        403,
      );
    }
    return next();
  }),
  { kind: "platform-admin" },
);
