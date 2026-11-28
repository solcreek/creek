/**
 * Cloudflare Access enforcement through the whole dispatch handler.
 *
 * A protected project is only reachable with a token its own Access issued,
 * which only arrives on the customer's domain. What this suite pins:
 *   - every address of a protected project refuses a request without a valid
 *     token: the default hostname, branch and deployment previews, and a
 *     custom domain not behind the Access application — and nothing is
 *     dispatched to the tenant's worker
 *   - a valid token is let through, and reaches the tenant's worker untouched
 *   - bypass paths are served without a token, on every hostname
 *   - the canonical redirect still happens first (it reveals nothing)
 *   - keys that can't be fetched → 503, never a pass
 *   - unprotected projects never fetch keys
 *   - before migration 0016, routing works and nothing is protected
 *   - the settings are cached with the route
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import type workerModule from "./index.js";
import { AUD, TEAM, type TestSigner, createSigner, validClaims } from "./access-test-helpers.js";

interface AccessCols {
  accessTeamDomain?: string | null;
  accessAud?: string | null;
  accessBypassPaths?: string | null;
}

const PROTECTED: AccessCols = {
  accessTeamDomain: TEAM,
  accessAud: AUD,
  accessBypassPaths: '["/health"]',
};

interface MockOptions {
  /** Access columns of project "site" in team "acme". */
  access?: AccessCols;
  primaryDomain?: string | null;
  redirectToPrimaryDomain?: number;
  /** Simulates a database before migration 0016. */
  preAccessMigration?: boolean;
}

let d1Calls: string[];

function createMockD1(opts: MockOptions): D1Database {
  const access = opts.access ?? {};
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const exec = {
        bind(...args: unknown[]) {
          bound = args;
          return exec;
        },
        async first<T>(): Promise<T | null> {
          const wantsAccess = sql.includes("p.accessTeamDomain");
          if (wantsAccess && opts.preAccessMigration) {
            throw new Error("D1_ERROR: no such column: p.accessTeamDomain: SQLITE_ERROR");
          }
          const cols = wantsAccess ? access : {};
          if (sql.includes("p.productionDeploymentId")) {
            d1Calls.push("production");
            const [project, team] = bound as [string, string];
            if (project !== "site" || team !== "acme") return null;
            return {
              productionDeploymentId: "dep_1",
              redirectToPrimaryDomain: opts.redirectToPrimaryDomain ?? 0,
              primaryDomain: opts.primaryDomain ?? null,
              ...cols,
            } as T;
          }
          if (sql.includes("FROM deployment")) {
            d1Calls.push("branch");
            return { id: "dep_branch", ...cols } as T;
          }
          if (sql.includes("FROM custom_domain")) {
            const [hostname] = bound as [string];
            if (sql.includes("t.plan")) {
              d1Calls.push("customPlan");
              return { plan: "pro" } as T;
            }
            d1Calls.push("customScript");
            if (hostname !== "app.customer.com" && hostname !== "other.customer.com") return null;
            return { slug: "site", team_slug: "acme", ...cols } as T;
          }
          if (sql.includes("FROM project p")) {
            d1Calls.push("deploymentAccess");
            return cols as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM organization")) {
            d1Calls.push("orgs");
            return { results: [{ slug: "acme", plan: "pro" }] as unknown as T[] };
          }
          return { results: [] };
        },
      };
      return exec;
    },
  } as unknown as D1Database;
}

let dispatched: { name: string; token: string | null }[];
let certFetches: string[];
let certsStatus: number;
let signer: TestSigner;
let worker: typeof workerModule;

function makeEnv(opts: MockOptions) {
  return {
    DISPATCHER: {
      get(name: string) {
        return {
          fetch: async (req: Request) => {
            dispatched.push({ name, token: req.headers.get("cf-access-jwt-assertion") });
            return new Response("tenant content", { status: 200 });
          },
        };
      },
    },
    DB: createMockD1(opts),
    CREEK_DOMAIN: "bycreek.com",
  } as unknown as Parameters<typeof workerModule.fetch>[1];
}

function get(url: string, token?: string): Request {
  return new Request(url, token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {});
}

beforeAll(async () => {
  signer = await createSigner();
});

beforeEach(async () => {
  d1Calls = [];
  dispatched = [];
  certFetches = [];
  certsStatus = 200;
  vi.stubGlobal("fetch", async (url: string) => {
    certFetches.push(String(url));
    return new Response(JSON.stringify(signer.certs), { status: certsStatus });
  });
  // The key cache is created at import, with the global fetch: import after stubbing.
  vi.resetModules();
  worker = (await import("./index.js")).default;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("protected project", () => {
  test.each([
    ["the default hostname", "https://site-acme.bycreek.com/"],
    ["a branch preview", "https://site-git-feature-acme.bycreek.com/"],
    ["a deployment preview", "https://site-a1b2c3d4-acme.bycreek.com/"],
    ["its custom domain, without a token", "https://app.customer.com/"],
  ])("%s refuses a request with no token, and dispatches nothing", async (_name, url) => {
    const res = await worker.fetch(get(url), makeEnv({ access: PROTECTED }));
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(dispatched).toEqual([]);
  });

  test("a valid token on the custom domain is let through, and the tenant still sees it", async () => {
    const token = await signer.sign(validClaims());
    const res = await worker.fetch(
      get("https://app.customer.com/", token),
      makeEnv({ access: PROTECTED }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tenant content");
    expect(dispatched).toEqual([{ name: "site-acme", token }]);
  });

  test("a token is checked the same way on every hostname (it is the only proof)", async () => {
    const token = await signer.sign(validClaims());
    const res = await worker.fetch(
      get("https://site-a1b2c3d4-acme.bycreek.com/", token),
      makeEnv({ access: PROTECTED }),
    );
    expect(res.status).toBe(200);
  });

  test.each([
    ["another team", { iss: "https://evil.cloudflareaccess.com" }],
    ["another application", { aud: ["b".repeat(64)] }],
    ["an expired session", { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])("a token from %s is refused", async (_name, patch) => {
    const token = await signer.sign({ ...validClaims(), ...patch });
    const res = await worker.fetch(
      get("https://app.customer.com/", token),
      makeEnv({ access: PROTECTED }),
    );
    expect(res.status).toBe(403);
    expect(dispatched).toEqual([]);
  });

  test("a forged token (another key) is refused", async () => {
    const forger = await createSigner();
    const token = await forger.sign(validClaims());
    const res = await worker.fetch(
      get("https://site-acme.bycreek.com/", token),
      makeEnv({ access: PROTECTED }),
    );
    expect(res.status).toBe(403);
  });

  test.each(["https://app.customer.com/health", "https://site-acme.bycreek.com/health/live"])(
    "a bypass path is served without a token: %s",
    async (url) => {
      const res = await worker.fetch(get(url), makeEnv({ access: PROTECTED }));
      expect(res.status).toBe(200);
      expect(certFetches).toEqual([]);
    },
  );

  test("a path that only resembles a bypass path is not", async () => {
    const res = await worker.fetch(
      get("https://app.customer.com/healthz"),
      makeEnv({ access: PROTECTED }),
    );
    expect(res.status).toBe(403);
  });

  test("the default hostname still redirects to the primary domain first", async () => {
    const res = await worker.fetch(
      get("https://site-acme.bycreek.com/docs?x=1"),
      makeEnv({ access: PROTECTED, primaryDomain: "app.customer.com", redirectToPrimaryDomain: 1 }),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://app.customer.com/docs?x=1");
    expect(dispatched).toEqual([]);
  });

  test("keys that can't be fetched answer 503, never a pass", async () => {
    certsStatus = 502;
    const token = await signer.sign(validClaims());
    const res = await worker.fetch(
      get("https://app.customer.com/", token),
      makeEnv({ access: PROTECTED }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(dispatched).toEqual([]);
  });

  test("half-written settings keep the project protected: everything is refused", async () => {
    const token = await signer.sign(validClaims());
    const res = await worker.fetch(
      get("https://app.customer.com/", token),
      makeEnv({ access: { accessTeamDomain: TEAM, accessAud: null } }),
    );
    expect(res.status).toBe(403);
    expect(certFetches).toEqual([]);
  });

  test("the settings are cached with the route: a second request costs no D1 work", async () => {
    const env = makeEnv({ access: PROTECTED });
    const token = await signer.sign(validClaims());
    await worker.fetch(get("https://app.customer.com/", token), env);
    const calls = d1Calls.length;
    expect((await worker.fetch(get("https://app.customer.com/"), env)).status).toBe(403);
    expect((await worker.fetch(get("https://app.customer.com/", token), env)).status).toBe(200);
    expect(d1Calls.length).toBe(calls);
    expect(certFetches).toHaveLength(1);
  });
});

describe("unprotected project", () => {
  test.each([
    "https://site-acme.bycreek.com/",
    "https://site-git-feature-acme.bycreek.com/",
    "https://site-a1b2c3d4-acme.bycreek.com/",
    "https://app.customer.com/",
  ])("%s serves without a token and fetches no keys", async (url) => {
    const res = await worker.fetch(get(url), makeEnv({}));
    expect(res.status).toBe(200);
    expect(certFetches).toEqual([]);
  });

  test("before migration 0016 every lookup falls back and serves", async () => {
    for (const url of [
      "https://site-acme.bycreek.com/",
      "https://site-git-feature-acme.bycreek.com/",
      "https://site-a1b2c3d4-acme.bycreek.com/",
      "https://app.customer.com/",
    ]) {
      const res = await worker.fetch(
        get(url),
        makeEnv({ access: PROTECTED, preAccessMigration: true }),
      );
      expect(res.status).toBe(200);
    }
    expect(dispatched.map((d) => d.name)).toEqual([
      "site-acme",
      "site-git-feature-acme",
      "site-a1b2c3d4-acme",
      "site-acme",
    ]);
  });
});
