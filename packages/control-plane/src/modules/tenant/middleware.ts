import { createMiddleware } from "hono/factory";
import type { Env } from "../../types.js";
import type { AuthUser } from "./types.js";
import { createAuth } from "./auth.js";
import { resolveTeam } from "./resolve.js";

type TenantEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string };
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
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    return c.json(
      { error: "unauthorized", message: "Missing or invalid authentication" },
      401,
    );
  }

  const user: AuthUser = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: (session.user as Record<string, unknown>).role as string | null ?? null,
    activeOrganizationId: (session.session as Record<string, unknown>).activeOrganizationId as string | null ?? null,
  };

  c.set("user", user);

  // --- Resolve team context ---
  const result = await resolveTeam(
    c.env.DB,
    user.id,
    c.req.header("x-creek-team"),
    user.activeOrganizationId,
  );

  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return c.json({ error: result.error, message: result.message }, status);
  }

  c.set("teamId", result.team.id);
  c.set("teamSlug", result.team.slug);
  return next();
});
