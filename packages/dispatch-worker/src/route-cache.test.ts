/**
 * Route cache: hostname → { scriptName, plan, isCustomDomain }.
 *
 * `resolveScriptName` ran on every request with no cache, against a
 * single-region D1 (WNAM, no read replication). From Taipei that meant a
 * cross-Pacific round trip before *anything* else — measured at ~0.33s to
 * a `cf-cache-status: HIT` asset, versus ~0.15s for the same object from a
 * US colo. It was also the platform's largest failure surface: one
 * mandatory long-haul dependency per request (see the Error 1101 report,
 * 2026-07-30).
 *
 * What this suite pins:
 *   - a repeat request costs ZERO D1 work, including the team-list read
 *   - the entry expires, so routing changes land within the TTL
 *   - 404s are NOT cached — a project created seconds ago must not stay
 *     404 for a minute
 *   - `isCustomDomain` survives the cache, because it decides whether
 *     `Set-Cookie` gets its `Domain=` narrowed (cross-tenant isolation)
 *   - a cached host keeps serving while D1 is down
 *   - the cache cannot grow without bound on attacker-supplied hostnames
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type workerModule from "./index.js";

/** Every D1 statement the worker executed, newest last. */
let d1Calls: string[];

interface MockOptions {
  orgs?: Array<{ slug: string; plan: string }>;
  productionDeployments?: Record<string, { productionDeploymentId: string | null }>;
  customDomains?: Record<string, { slug: string; team_slug: string; plan: string }>;
  /** When true, every statement rejects. */
  down?: boolean;
}

function createMockD1(opts: MockOptions = {}): D1Database {
  const orgs = opts.orgs ?? [{ slug: "acme", plan: "pro" }];
  const productionDeployments = opts.productionDeployments ?? {
    "site|acme": { productionDeploymentId: "dep_1" },
  };
  const customDomains = opts.customDomains ?? {};

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const exec = {
        bind(...args: unknown[]) {
          bound = args;
          return exec;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("p.productionDeploymentId")) {
            d1Calls.push("production");
            if (opts.down) throw new Error("Network connection lost.");
            const [project, team] = bound as [string, string];
            return (productionDeployments[`${project}|${team}`] ?? null) as T | null;
          }
          if (sql.includes("FROM custom_domain")) {
            d1Calls.push(sql.includes("t.plan") ? "customPlan" : "customScript");
            if (opts.down) throw new Error("Network connection lost.");
            const [hostname] = bound as [string];
            return (customDomains[hostname] ?? null) as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM organization")) {
            d1Calls.push("orgs");
            if (opts.down) throw new Error("Network connection lost.");
            return { results: orgs as unknown as T[] };
          }
          return { results: [] };
        },
      };
      return exec;
    },
  } as unknown as D1Database;
}

let dispatched: string[];
let workerResponse: () => Response;

function makeEnv(db: D1Database) {
  return {
    DISPATCHER: {
      get(name: string) {
        dispatched.push(name);
        return { fetch: async () => workerResponse() };
      },
    },
    DB: db,
    CREEK_DOMAIN: "bycreek.com",
  } as unknown as Parameters<typeof workerModule.fetch>[1];
}

let worker: typeof workerModule;

beforeEach(async () => {
  d1Calls = [];
  dispatched = [];
  workerResponse = () => new Response("ok", { status: 200 });
  vi.resetModules();
  worker = (await import("./index.js")).default;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROD = "https://site-acme.bycreek.com/";

describe("a repeat request does no D1 work", () => {
  test("second request for the same host makes zero queries", async () => {
    const env = makeEnv(createMockD1());

    await worker.fetch(new Request(PROD), env);
    const afterFirst = [...d1Calls];
    expect(afterFirst.length).toBeGreaterThan(0);

    d1Calls = [];
    const res = await worker.fetch(new Request(PROD), env);

    expect(res.status).toBe(200);
    expect(d1Calls).toEqual([]); // not even the team-list read
    expect(dispatched).toEqual(["site-acme", "site-acme"]);
  });

  test("a different host is resolved on its own", async () => {
    const env = makeEnv(
      createMockD1({
        productionDeployments: {
          "site|acme": { productionDeploymentId: "dep_1" },
          "shop|acme": { productionDeploymentId: "dep_2" },
        },
      }),
    );

    await worker.fetch(new Request(PROD), env);
    d1Calls = [];
    await worker.fetch(new Request("https://shop-acme.bycreek.com/"), env);

    expect(d1Calls).toContain("production");
    expect(dispatched).toEqual(["site-acme", "shop-acme"]);
  });

  test("a custom domain caches both of its round trips", async () => {
    const env = makeEnv(
      createMockD1({
        customDomains: {
          "app.acme-corp.com": { slug: "site", team_slug: "acme", plan: "pro" },
        },
      }),
    );

    await worker.fetch(new Request("https://app.acme-corp.com/"), env);
    expect(d1Calls).toContain("customScript");
    expect(d1Calls).toContain("customPlan");

    d1Calls = [];
    await worker.fetch(new Request("https://app.acme-corp.com/"), env);
    expect(d1Calls).toEqual([]);
  });
});

describe("staleness is bounded", () => {
  test("the entry expires, so routing changes land", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    const env = makeEnv(createMockD1());

    await worker.fetch(new Request(PROD), env);
    d1Calls = [];

    vi.setSystemTime(new Date("2026-07-31T00:00:59Z")); // still inside the TTL
    await worker.fetch(new Request(PROD), env);
    expect(d1Calls).toEqual([]);

    vi.setSystemTime(new Date("2026-07-31T00:01:01Z")); // past it
    await worker.fetch(new Request(PROD), env);
    expect(d1Calls).toContain("production");
  });

  test("a 404 is never cached", async () => {
    // Caching negatives would leave a project created seconds ago
    // unreachable for a full TTL.
    const env = makeEnv(createMockD1({ productionDeployments: {} }));

    const first = await worker.fetch(new Request("https://new-acme.bycreek.com/"), env);
    expect(first.status).toBe(404);

    d1Calls = [];
    await worker.fetch(new Request("https://new-acme.bycreek.com/"), env);
    expect(d1Calls).toContain("production"); // retried, not served from cache
  });
});

describe("cross-tenant isolation survives the cache", () => {
  test("a shared subdomain still gets Set-Cookie Domain narrowed on a cache hit", async () => {
    // `isCustomDomain` is carried in the cache entry. If a cache hit lost
    // it, a tenant on *.bycreek.com could scope a cookie to the parent and
    // have it land on a sibling tenant.
    const env = makeEnv(createMockD1());
    workerResponse = () =>
      new Response("ok", {
        status: 200,
        headers: { "Set-Cookie": "sid=1; Domain=.bycreek.com; Path=/" },
      });

    await worker.fetch(new Request(PROD), env); // populates the cache
    const res = await worker.fetch(new Request(PROD), env); // served from it

    const cookie = res.headers.getSetCookie()[0];
    expect(cookie).toContain("sid=1");
    expect(cookie).not.toContain("Domain");
  });

  test("a custom domain keeps its own Domain attribute on a cache hit", async () => {
    // The inverse error: narrowing a tenant's cookie on their own domain
    // would break subdomain sessions they legitimately own.
    const env = makeEnv(
      createMockD1({
        customDomains: {
          "app.acme-corp.com": { slug: "site", team_slug: "acme", plan: "pro" },
        },
      }),
    );
    workerResponse = () =>
      new Response("ok", {
        status: 200,
        headers: { "Set-Cookie": "sid=1; Domain=.acme-corp.com; Path=/" },
      });

    await worker.fetch(new Request("https://app.acme-corp.com/"), env);
    const res = await worker.fetch(new Request("https://app.acme-corp.com/"), env);

    expect(res.headers.getSetCookie()[0]).toContain("Domain=.acme-corp.com");
  });
});

describe("resilience while D1 is unreachable", () => {
  test("an already-cached host keeps serving", async () => {
    const healthy = createMockD1();
    const env = makeEnv(healthy);
    await worker.fetch(new Request(PROD), env);

    const res = await worker.fetch(new Request(PROD), makeEnv(createMockD1({ down: true })));
    expect(res.status).toBe(200);
  });

  test("a stale team list is preferred over refusing the request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));

    // Warm the team list, then let it age out while D1 is down. A new
    // hostname still resolves from the stale list rather than 503-ing.
    await worker.fetch(new Request(PROD), makeEnv(createMockD1()));

    vi.setSystemTime(new Date("2026-07-31T00:06:00Z")); // past TEAM_CACHE_TTL

    // Only the team-list read fails; the project lookup still answers.
    const orgDown = {
      prepare(sql: string) {
        const exec = {
          bind: () => exec,
          async first<T>(): Promise<T | null> {
            if (!sql.includes("p.productionDeploymentId")) return null;
            d1Calls.push("production");
            return { productionDeploymentId: "dep_2" } as T;
          },
          async all(): Promise<never> {
            d1Calls.push("orgs");
            throw new Error("Network connection lost.");
          },
        };
        return exec;
      },
    } as unknown as D1Database;

    const res = await worker.fetch(new Request("https://shop-acme.bycreek.com/"), makeEnv(orgDown));

    expect(res.status).toBe(200);
    expect(dispatched).toContain("shop-acme");
    expect(d1Calls).toContain("orgs"); // it did try, and fell back
  });
});

describe("a sustained outage does not flood the logs", () => {
  /** D1 whose team-list read always fails; project lookups still answer. */
  function orgDownD1(): D1Database {
    return {
      prepare(sql: string) {
        const exec = {
          bind: () => exec,
          async first<T>(): Promise<T | null> {
            if (!sql.includes("p.productionDeploymentId")) return null;
            return { productionDeploymentId: "dep" } as T;
          },
          async all(): Promise<never> {
            throw new Error("Network connection lost.");
          },
        };
        return exec;
      },
    } as unknown as D1Database;
  }

  test("the stale-list warning is throttled, but the retry is not", async () => {
    // `teamsCacheTime` is deliberately not advanced so every request
    // retries. Warning on each of them would flood Workers Logs for the
    // whole outage — precisely when an operator needs to read them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });

    await worker.fetch(new Request(PROD), makeEnv(createMockD1())); // warm
    vi.setSystemTime(new Date("2026-07-31T00:06:00Z")); // team list now stale

    const down = makeEnv(orgDownD1());
    for (let i = 0; i < 25; i++) {
      // Distinct hosts so the route cache never short-circuits getTeams.
      await worker.fetch(new Request(`https://p${i}-acme.bycreek.com/`), down);
    }

    expect(warns).toHaveLength(1);
  });

  test("it warns again once the interval has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });

    await worker.fetch(new Request(PROD), makeEnv(createMockD1()));
    vi.setSystemTime(new Date("2026-07-31T00:06:00Z"));

    const down = makeEnv(orgDownD1());
    await worker.fetch(new Request("https://a-acme.bycreek.com/"), down);
    vi.setSystemTime(new Date("2026-07-31T00:07:30Z")); // past the interval
    await worker.fetch(new Request("https://b-acme.bycreek.com/"), down);

    expect(warns).toHaveLength(2);
  });
});

describe("the cache is bounded", () => {
  test("it does not grow without limit on unique hostnames", async () => {
    // Hostnames are attacker-suppliable; an unbounded Map in a long-lived
    // isolate is a memory-exhaustion vector.
    const deployments: Record<string, { productionDeploymentId: string | null }> = {};
    for (let i = 0; i < 2100; i++) deployments[`p${i}|acme`] = { productionDeploymentId: "d" };
    const env = makeEnv(createMockD1({ productionDeployments: deployments }));

    for (let i = 0; i < 2100; i++) {
      await worker.fetch(new Request(`https://p${i}-acme.bycreek.com/`), env);
    }

    // The oldest entries were evicted, so the first host resolves again.
    d1Calls = [];
    await worker.fetch(new Request("https://p0-acme.bycreek.com/"), env);
    expect(d1Calls).toContain("production");
  });
});
