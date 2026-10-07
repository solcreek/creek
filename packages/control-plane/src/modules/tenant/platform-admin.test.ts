import { describe, it, expect, afterEach } from "vitest";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { app } from "../../index.js";
import { createAuth } from "./auth.js";
import type { Env } from "../../types.js";

/**
 * GET /web-deploy/list through the real app and real Better Auth: it lists
 * every visitor's sandbox deploy, so only a platform admin (user.role =
 * "admin") may read it — by cookie or by API key.
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
    // Refused connection: the route's sandbox-api lookup must not leave the box.
    SANDBOX_API_URL: "http://127.0.0.1:1",
  } as Env;
}

function cookieHeader(res: Response): string {
  return (res.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function signUp(env: Env, email: string): Promise<{ cookie: string; key: string }> {
  const auth = createAuth(env);
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ name: email, email, password: "password123" }),
    }),
  );
  expect(res.status).toBe(200);
  const cookie = cookieHeader(res);
  const created = await auth.handler(
    new Request(`${BASE}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ name: "ops" }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  return { cookie, key };
}

/** The same user, once by session cookie and once by API key. */
function bothCredentials(cookie: string, key: string): Record<string, string>[] {
  return [{ cookie }, { "x-api-key": key }];
}

describe("GET /web-deploy/list — platform admin only", () => {
  let t: LocalTestEnv;

  afterEach(() => {
    t?.cleanup();
  });

  const list = (env: Env, headers: Record<string, string> = {}) =>
    app.request("/web-deploy/list", { headers }, env);

  it("rejects an unauthenticated request with 401", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const res = await list(authEnv(t));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("rejects a signed-in team owner who is not a platform admin with 403", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const env = authEnv(t);
    const { cookie, key } = await signUp(env, "owner@example.com");

    for (const headers of bothCredentials(cookie, key)) {
      const res = await list(env, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
  });

  it("serves a platform admin by cookie and by API key", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const env = authEnv(t);
    const { cookie, key } = await signUp(env, "operator@example.com");
    await t.env.DB.prepare("UPDATE user SET role = 'admin' WHERE email = ?")
      .bind("operator@example.com")
      .run();
    await t.env.BUILD_STATUS.put(
      "build:b1",
      JSON.stringify({ buildId: "b1", status: "building", createdAt: "2026-10-07T00:00:00Z" }),
    );

    for (const headers of bothCredentials(cookie, key)) {
      const res = await list(env, headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        expect.objectContaining({ buildId: "b1", source: "kv", environment: "sandbox" }),
      ]);
    }
  });

  it("re-reads the role on each request, so a demoted admin loses access at once", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const env = authEnv(t);
    // The sign-up cookie carries a cached session snapshot (role "user");
    // the check must ignore that cache in both directions.
    const { cookie, key } = await signUp(env, "former@example.com");
    await t.env.DB.prepare("UPDATE user SET role = 'admin'").run();
    for (const headers of bothCredentials(cookie, key)) {
      expect((await list(env, headers)).status).toBe(200);
    }

    await t.env.DB.prepare("UPDATE user SET role = 'user'").run();
    for (const headers of bothCredentials(cookie, key)) {
      expect((await list(env, headers)).status).toBe(403);
    }
  });
});
