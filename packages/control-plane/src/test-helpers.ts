import { Hono } from "hono";
import { cors } from "hono/cors";
import { projects } from "./modules/projects/routes.js";
import { deployments } from "./modules/deployments/routes.js";
import { domains } from "./modules/domains/routes.js";
import { envVars } from "./modules/env/routes.js";
import { instantDeploy } from "./modules/deployments/instant-deploy.js";
import type { Env } from "./types.js";
import type { AuthUser } from "./modules/tenant/types.js";
import type { AuditRequestContext } from "./modules/audit/types.js";

/**
 * Lightweight D1 mock for unit testing control-plane routes.
 *
 * Usage:
 *   const db = createMockD1();
 *   db.seed("SELECT ... WHERE slug = ?", ["my-app"], { id: "1", slug: "my-app" });
 *   // Now db.prepare("SELECT ... WHERE slug = ?").bind("my-app").first() returns the seeded row
 */

interface SeededQuery {
  sqlPattern: string;
  args: unknown[];
  result: unknown;
  mode: "first" | "all" | "run";
}

export function createMockD1() {
  const seeded: SeededQuery[] = [];
  const executed: { sql: string; args: unknown[] }[] = [];

  function matchQuery(sql: string, args: unknown[]): SeededQuery | undefined {
    return seeded.find(
      (s) =>
        sql.includes(s.sqlPattern) &&
        JSON.stringify(args) === JSON.stringify(s.args),
    );
  }

  function createStatement(sql: string) {
    let boundArgs: unknown[] = [];

    const stmt = {
      bind(...args: unknown[]) {
        boundArgs = args;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        executed.push({ sql, args: boundArgs });
        const match = matchQuery(sql, boundArgs);
        if (match) return match.result as T;
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        executed.push({ sql, args: boundArgs });
        const match = matchQuery(sql, boundArgs);
        if (match) return match.result as { results: T[] };
        return { results: [] };
      },
      async run() {
        executed.push({ sql, args: boundArgs });
        const match = matchQuery(sql, boundArgs);
        if (match) return match.result;
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  const db = {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch(stmts: any[]) {
      const results = [];
      for (const stmt of stmts) {
        results.push(await stmt.run());
      }
      return results;
    },

    // Test helpers
    seedFirst(sqlPattern: string, args: unknown[], result: unknown) {
      seeded.push({ sqlPattern, args, result, mode: "first" });
    },
    seedAll(sqlPattern: string, args: unknown[], result: { results: unknown[] }) {
      seeded.push({ sqlPattern, args, result, mode: "all" });
    },
    seedRun(sqlPattern: string, args: unknown[], result?: unknown) {
      seeded.push({
        sqlPattern,
        args,
        result: result ?? { meta: { changes: 1 } },
        mode: "run",
      });
    },
    getExecuted() {
      return executed;
    },
    reset() {
      seeded.length = 0;
      executed.length = 0;
    },
  };

  return db;
}

export type MockD1 = ReturnType<typeof createMockD1>;

export function createMockR2() {
  const store = new Map<string, unknown>();
  return {
    async get(key: string) {
      const val = store.get(key);
      if (!val) return null;
      return {
        body: val,
        text: async () => typeof val === "string" ? val : JSON.stringify(val),
        json: async () => typeof val === "string" ? JSON.parse(val) : val,
      };
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/**
 * Build a test Env with mock bindings.
 */
export function createTestEnv(db?: MockD1): Env {
  return {
    DB: (db ?? createMockD1()) as unknown as D1Database,
    ASSETS: createMockR2() as unknown as R2Bucket,
    CREEK_DOMAIN: "bycreek.com",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    DISPATCH_NAMESPACE: "test-namespace",
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:8787",
    GITHUB_CLIENT_ID: "test-github-id",
    GITHUB_CLIENT_SECRET: "test-github-secret",
    GOOGLE_CLIENT_ID: "test-google-id",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    CLOUDFLARE_ZONE_ID: "test-zone-id",
    BUILD_STATUS: { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace,
    REMOTE_BUILDER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    WEB_BUILDS: { send: async () => {} } as unknown as Queue,
    SANDBOX_API_URL: "https://sandbox-api.creek.dev",
    INTERNAL_SECRET: "test-internal-secret",
  };
}

/**
 * Create a test Hono app that bypasses Better Auth middleware.
 * Directly injects user + team context so route logic can be tested in isolation.
 */
/** Default audit context for tests */
export const TEST_AUDIT_CTX: AuditRequestContext = {
  ip: "127.0.0.1",
  ipHash: "test-ip-hash-0000",
  country: "US",
  userAgent: "test-agent",
  cfRay: "test-ray-id",
};

export function createTestApp(user: AuthUser, teamId: string, teamSlug: string) {
  type TestEnv = {
    Bindings: Env;
    Variables: { user: AuthUser; teamId: string; teamSlug: string; auditCtx: AuditRequestContext };
  };

  const app = new Hono<TestEnv>();
  app.use("*", cors());

  // Health check (no auth)
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Inject auth + team + audit context directly (skip Better Auth + audit middleware)
  app.use("/projects/*", async (c, next) => {
    c.set("user", user);
    c.set("teamId", teamId);
    c.set("teamSlug", teamSlug);
    c.set("auditCtx", TEST_AUDIT_CTX);
    return next();
  });
  app.use("/instant-deploy/*", async (c, next) => {
    c.set("user", user);
    c.set("teamId", teamId);
    c.set("teamSlug", teamSlug);
    c.set("auditCtx", TEST_AUDIT_CTX);
    return next();
  });

  app.route("/projects", projects);
  app.route("/projects", deployments);
  app.route("/projects", domains);
  app.route("/projects", envVars);
  app.route("/instant-deploy", instantDeploy);

  return app;
}

/** Default test user */
export const TEST_USER: AuthUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  role: "user",
  activeOrganizationId: null,
};

/** Default test team */
export const TEST_TEAM = {
  id: "team-1",
  slug: "my-team",
};

/**
 * Seed a member record so RBAC middleware passes.
 * Call in beforeEach after creating the mock D1.
 */
export function seedMemberRole(db: MockD1, role: string = "owner") {
  db.seedFirst("SELECT role FROM member", [TEST_USER.id, TEST_TEAM.id], { role });
}
