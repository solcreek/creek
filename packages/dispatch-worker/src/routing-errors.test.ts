/**
 * Regression suite for the routing-lookup failure path.
 *
 * Background (reported 2026-07-30): a tenant saw intermittent full-page
 * Cloudflare Error 1101 ("Worker threw exception") with no corresponding
 * entry in `creek logs`. Root cause: the three D1 lookups that resolve
 * hostname → script name → plan ran OUTSIDE any try/catch, so a transient
 * D1 failure escaped as an uncaught exception. creek-db is single-region
 * with read replication disabled, so every request from every colo pays a
 * long-haul round trip through those lookups — a large, permanently
 * exposed failure surface.
 *
 * The invariants locked in here:
 *   - a D1 failure at ANY of the three lookup sites yields 503, never a
 *     thrown exception (which the edge would render as 1101)
 *   - the 503 is `no-store` + `Retry-After`, and never leaks the
 *     underlying D1 error text to the visitor
 *   - "host resolved but no deployment" stays a 404 — a broken lookup and
 *     a genuinely-unknown host must not be conflated
 *   - the healthy path is untouched, and an unknown host still costs
 *     exactly one lookup round (no speculative plan query)
 *
 * Each test re-imports the worker module: `teamsCache` is module-level
 * state with a 5-minute TTL, so without a fresh module a passing lookup in
 * one test would satisfy the next one from cache and silently skip the D1
 * call under test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

type Site = "orgs" | "production" | "customScript" | "customPlan";

interface MockD1Options {
  /** Lookup sites that should reject instead of returning a row. */
  throwAt?: Site[];
  orgs?: Array<{ slug: string; plan: string }>;
  /** Keyed `${project}|${team}` → productionDeploymentId row. */
  productionDeployments?: Record<string, { productionDeploymentId: string | null }>;
  /** Keyed by hostname. */
  customDomains?: Record<string, { slug: string; team_slug: string; plan: string }>;
}

/** Records which lookup sites were actually reached, in order. */
let d1Calls: Site[];

function createMockD1(opts: MockD1Options = {}): D1Database {
  const throwAt = new Set(opts.throwAt ?? []);
  const orgs = opts.orgs ?? [{ slug: "acme", plan: "pro" }];
  const productionDeployments = opts.productionDeployments ?? {};
  const customDomains = opts.customDomains ?? {};

  function hit(site: Site) {
    d1Calls.push(site);
    if (throwAt.has(site)) {
      // The exact shape Workers surfaces when a binding's connection dies
      // mid-flight — the message the tenant's report quoted.
      throw new Error("Network connection lost.");
    }
  }

  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      const exec = {
        bind(...args: unknown[]) {
          boundArgs = args;
          return exec;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("p.productionDeploymentId")) {
            hit("production");
            const [project, team] = boundArgs as [string, string];
            return (productionDeployments[`${project}|${team}`] ?? null) as T | null;
          }
          if (sql.includes("FROM custom_domain")) {
            // resolveScriptName selects `p.slug, t.slug as team_slug`;
            // resolveTeamPlan selects `t.plan`. Two distinct round trips.
            hit(sql.includes("t.plan") ? "customPlan" : "customScript");
            const [hostname] = boundArgs as [string];
            return (customDomains[hostname] ?? null) as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM organization")) {
            hit("orgs");
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

function createMockDispatcher(response: () => Response) {
  return {
    get(name: string) {
      dispatched.push(name);
      return {
        async fetch(): Promise<Response> {
          return response();
        },
      };
    },
  };
}

function makeEnv(d1: D1Database) {
  return {
    DISPATCHER: createMockDispatcher(() => new Response("hello", { status: 200 })),
    DB: d1,
    CREEK_DOMAIN: "bycreek.com",
  } as unknown as Parameters<Awaited<typeof import("./index.js")>["default"]["fetch"]>[1];
}

/** Fresh module per test — see the header note on `teamsCache`. */
async function loadWorker() {
  vi.resetModules();
  return (await import("./index.js")).default;
}

let errorLogs: string[];

beforeEach(() => {
  d1Calls = [];
  dispatched = [];
  errorLogs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HEALTHY_PROD = {
  orgs: [{ slug: "eli-chen-f443", plan: "free" }],
  productionDeployments: {
    "nii-course-system|eli-chen-f443": { productionDeploymentId: "dep_123" },
  },
} satisfies MockD1Options;

const PROD_URL = "https://nii-course-system-eli-chen-f443.bycreek.com/dashboard";

describe("routing lookup failures never become Error 1101", () => {
  test("team-list query fails → 503, worker never dispatched", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(
      new Request(PROD_URL),
      makeEnv(createMockD1({ ...HEALTHY_PROD, throwAt: ["orgs"] })),
    );

    expect(res.status).toBe(503);
    expect(dispatched).toEqual([]);
  });

  test("script-name lookup fails → 503, worker never dispatched", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(
      new Request(PROD_URL),
      makeEnv(createMockD1({ ...HEALTHY_PROD, throwAt: ["production"] })),
    );

    expect(res.status).toBe(503);
    expect(dispatched).toEqual([]);
  });

  test("plan lookup fails on a custom domain → 503", async () => {
    // Custom domains are the only path that spends a second D1 round trip
    // resolving the plan, so it's the only place this site can fail.
    const worker = await loadWorker();
    const res = await worker.fetch(
      new Request("https://courses.example.com/dashboard"),
      makeEnv(
        createMockD1({
          throwAt: ["customPlan"],
          customDomains: {
            "courses.example.com": {
              slug: "nii-course-system",
              team_slug: "eli-chen-f443",
              plan: "free",
            },
          },
        }),
      ),
    );

    expect(res.status).toBe(503);
    expect(d1Calls).toContain("customScript"); // got past resolution…
    expect(dispatched).toEqual([]); // …but never dispatched
  });

  test("503 carries Retry-After and is never cached", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(
      new Request(PROD_URL),
      makeEnv(createMockD1({ ...HEALTHY_PROD, throwAt: ["production"] })),
    );

    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("503 body does not leak the underlying D1 error to the visitor", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(
      new Request(PROD_URL),
      makeEnv(createMockD1({ ...HEALTHY_PROD, throwAt: ["production"] })),
    );

    const body = await res.text();
    expect(body).toBe("Service Unavailable");
    expect(body).not.toContain("Network connection lost");
  });

  test("the failure is logged, so the trace carries a reason", async () => {
    // creek-tail can only surface what the invocation recorded. Without
    // this line a 503 would be as opaque as the 1101 it replaced.
    const worker = await loadWorker();
    await worker.fetch(
      new Request(PROD_URL),
      makeEnv(createMockD1({ ...HEALTHY_PROD, throwAt: ["production"] })),
    );

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain("nii-course-system-eli-chen-f443.bycreek.com");
    expect(errorLogs[0]).toContain("Network connection lost.");
  });
});

describe("healthy lookups are unaffected", () => {
  test("known host dispatches to the production script", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(new Request(PROD_URL), makeEnv(createMockD1(HEALTHY_PROD)));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(dispatched).toEqual(["nii-course-system-eli-chen-f443"]);
  });

  test("unknown host stays 404 — a broken lookup and a missing one differ", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(
      new Request("https://no-such-project-eli-chen-f443.bycreek.com/"),
      makeEnv(createMockD1(HEALTHY_PROD)),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("a 404 does not spend a plan lookup", async () => {
    // Regression guard on lookup ordering: resolveTeamPlan must stay behind
    // the null-scriptName check, or every 404 would cost an extra
    // cross-region D1 round trip.
    const worker = await loadWorker();
    await worker.fetch(
      new Request("https://courses.example.com/"),
      makeEnv(createMockD1({ customDomains: {} })),
    );

    expect(d1Calls).toContain("customScript");
    expect(d1Calls).not.toContain("customPlan");
  });
});
