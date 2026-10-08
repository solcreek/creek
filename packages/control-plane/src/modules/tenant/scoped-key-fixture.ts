/**
 * Test fixture: a real Better Auth instance over the local SQLite test env,
 * with helpers to sign up users and mint legacy or scoped API keys the way
 * the server will. Used by the scoped-key integration tests only.
 */
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { app } from "../../index.js";
import { createAuth } from "./auth.js";
import { scopedKeyPermissions } from "./api-key-grant.js";
import type { Scope } from "./scopes.js";
import type { Env } from "../../types.js";

const BASE = "http://localhost:8787";
const ORIGIN = "http://localhost:5173";

export interface Fixture {
  t: LocalTestEnv;
  env: Env;
  /** Sign up a user (who gets a personal org as owner). */
  signUp(
    email: string,
  ): Promise<{ userId: string; orgId: string; orgSlug: string; cookie: string }>;
  /** A key with no scopes stored — the pre-scopes behavior. */
  legacyKey(cookie: string): Promise<string>;
  /** A scoped key, created server-side as the key-management route will. */
  scopedKey(userId: string, teamId: string, scopes: readonly Scope[]): Promise<string>;
  /** Call the deployed Worker app. */
  call(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: unknown,
  ): Promise<Response>;
  sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]>;
  /** Wait for work the app handed to executionCtx.waitUntil(). */
  settle(): Promise<void>;
  cleanup(): void;
}

function cookieHeader(res: Response): string {
  return (res.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

export function createFixture(): Fixture {
  const t = createLocalTestEnv({ applyMigrations: true });
  const env = {
    ...t.env,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh",
    GOOGLE_CLIENT_ID: "gg",
    GOOGLE_CLIENT_SECRET: "gg",
    // Refused connections: handlers that run must not reach real services.
    SANDBOX_API_URL: "http://127.0.0.1:1",
    CLOUDFLARE_API_TOKEN: "",
  } as Env;
  const auth = createAuth(env);
  // Background work (deploy jobs, cache deploys) runs as in the Worker; a
  // test can await it with settle(). Failures are the handler's to log.
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const sql: Fixture["sql"] = async (query, ...params) => {
    const stmt = t.env.DB.prepare(query).bind(...params);
    if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
      await stmt.run();
      return [];
    }
    return ((await stmt.all()) as { results: never[] }).results;
  };

  return {
    t,
    env,
    sql,
    async signUp(email) {
      const res = await auth.handler(
        new Request(`${BASE}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ name: email, email, password: "password123" }),
        }),
      );
      if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
      const [row] = await sql<{ userId: string; orgId: string; orgSlug: string }>(
        `SELECT u.id AS userId, o.id AS orgId, o.slug AS orgSlug FROM user u
         JOIN member m ON m.userId = u.id JOIN organization o ON o.id = m.organizationId
         WHERE u.email = ?`,
        email,
      );
      return { ...row, cookie: cookieHeader(res) };
    },
    async legacyKey(cookie) {
      const res = await auth.handler(
        new Request(`${BASE}/api/auth/api-key/create`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie },
          body: JSON.stringify({ name: "legacy" }),
        }),
      );
      if (res.status !== 200) throw new Error(`key create failed: ${res.status}`);
      return ((await res.json()) as { key: string }).key;
    },
    async scopedKey(userId, teamId, scopes) {
      const created = await auth.api.createApiKey({
        body: { userId, name: "scoped", permissions: scopedKeyPermissions(scopes, teamId) },
      });
      return created.key;
    },
    call(method, path, headers = {}, body) {
      const init: RequestInit = { method, headers: { ...headers } };
      if (body !== undefined && method !== "GET" && method !== "HEAD") {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
      return Promise.resolve(app.request(path, init, env, executionCtx));
    },
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    cleanup: () => t.cleanup(),
  };
}
