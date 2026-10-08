import { createMiddleware } from "hono/factory";
import type { Env } from "../../types.js";
import { createAuth } from "./auth.js";

/**
 * Gate a route to platform operators: users whose Better Auth admin-plugin
 * role is "admin". This is the instance-wide role on the `user` row, not a
 * team role — it answers "who runs this Creek install", so team owners don't
 * pass it.
 *
 * Auth: session cookie or `x-api-key`, same as tenantMiddleware. No team is
 * resolved: platform routes are not team-scoped.
 */
export const requirePlatformAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // Skip the 5-minute session cookie cache: it snapshots the user row, so a
  // granted or revoked admin role would otherwise lag by up to 5 minutes.
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }
  const role = (session.user as Record<string, unknown>).role;
  if (role !== "admin") {
    return c.json(
      { error: "forbidden", message: "This endpoint requires a platform admin account" },
      403,
    );
  }
  return next();
});
