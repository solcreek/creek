import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { createAuth } from "./auth.js";
import { tenantMiddleware } from "./middleware.js";
import { requirePermission } from "./permissions.js";
import type { Env } from "../../types.js";
import type { TenantContext } from "./types.js";

/**
 * The production handoff end to end: a real Better Auth session goes through
 * tenantMiddleware, which resolves the team and member role via resolveTeam,
 * and requirePermission decides from the role it finds in context.
 */

const BASE = "http://localhost:8787";
const ORIGIN = "http://localhost:5173";

function authEnv(t: LocalTestEnv): Env {
  return {
    ...t.env,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh",
    GOOGLE_CLIENT_ID: "gg",
    GOOGLE_CLIENT_SECRET: "gg",
  } as Env;
}

function cookieHeader(res: Response): string {
  return (res.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: TenantContext }>();
  app.use("*", tenantMiddleware);
  app.get("/whoami", (c) =>
    c.json({
      teamId: c.get("teamId"),
      teamSlug: c.get("teamSlug"),
      memberRole: c.get("memberRole") ?? null,
    }),
  );
  app.delete("/owner-only", requirePermission("project:delete"), (c) => c.json({ ok: true }));
  app.post("/any-member", requirePermission("deploy:create"), (c) => c.json({ ok: true }));
  return app;
}

describe("tenantMiddleware → requirePermission", () => {
  let t: LocalTestEnv;

  afterEach(() => {
    t?.cleanup();
  });

  it("carries the resolved member role into permission checks on every request", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const env = authEnv(t);
    const auth = createAuth(env);

    const signUp = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          name: "Owner",
          email: "owner@example.com",
          password: "password123",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const cookie = cookieHeader(signUp);

    const app = buildApp();
    const call = (path: string, method = "GET") =>
      app.request(path, { method, headers: { cookie, origin: ORIGIN } }, env);

    // Sign-up created a personal organization with the user as owner.
    const org = await t.env.DB.prepare("SELECT id, slug FROM organization").first<{
      id: string;
      slug: string;
    }>();
    expect(await (await call("/whoami")).json()).toEqual({
      teamId: org!.id,
      teamSlug: org!.slug,
      memberRole: "owner",
    });
    expect((await call("/owner-only", "DELETE")).status).toBe(200);
    expect((await call("/any-member", "POST")).status).toBe(200);

    // Demote the membership: the role must be read from the member row on
    // each request, not remembered from the session or an earlier call.
    await t.env.DB.prepare("UPDATE member SET role = 'member'").run();
    const demoted = (await (await call("/whoami")).json()) as { memberRole: string | null };
    expect(demoted.memberRole).toBe("member");
    expect((await call("/owner-only", "DELETE")).status).toBe(403);
    expect((await call("/any-member", "POST")).status).toBe(200);

    // Remove the membership: the user belongs to no team, resolveTeam answers
    // no_team (400), and no role ever reaches the route.
    await t.env.DB.prepare("DELETE FROM member").run();
    expect((await call("/whoami")).status).toBe(400);
    expect((await call("/owner-only", "DELETE")).status).toBe(400);
  });

  it("rejects unauthenticated requests before resolving any team", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const res = await buildApp().request("/whoami", { headers: { origin: ORIGIN } }, authEnv(t));
    expect(res.status).toBe(401);
  });
});
