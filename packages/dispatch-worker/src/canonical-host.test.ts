/**
 * Canonical host: a project with an active primary custom domain has two
 * addresses for the same content — its own domain and the default
 * `{project}-{team}.bycreek.com`. Left alone, search engines index both and
 * visitors hold a session on each.
 *
 * What this suite pins:
 *   - the default production hostname 308s to the primary domain, keeping
 *     path, query and method
 *   - a project that turned the redirect off serves, marked noindex
 *   - a project with NO custom domain is untouched: the default hostname is
 *     its only address and must stay indexable
 *   - previews (branch, deployment) are always noindex and never redirect
 *   - the custom domain itself is never redirected or marked
 *   - the decision is cached with the route: no extra D1 work
 *   - before migration 0014 (columns missing) routing still works
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type workerModule from "./index.js";

interface ProjectRow {
  productionDeploymentId: string | null;
  redirectToPrimaryDomain?: number;
  primaryDomain?: string | null;
}

interface MockOptions {
  projects?: Record<string, ProjectRow>;
  customDomains?: Record<string, { slug: string; team_slug: string; plan: string }>;
  branches?: string[];
  /** Simulates a database before migration 0014. */
  preMigration?: boolean;
  /** Error thrown by the production lookup. */
  productionError?: string;
}

let d1Calls: string[];

function createMockD1(opts: MockOptions): D1Database {
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
            const withCanonical = sql.includes("isPrimary");
            d1Calls.push(withCanonical ? "production" : "productionLegacy");
            if (opts.productionError) throw new Error(opts.productionError);
            if (withCanonical && opts.preMigration) {
              throw new Error("D1_ERROR: no such column: p.redirectToPrimaryDomain: SQLITE_ERROR");
            }
            const [project, team] = bound as [string, string];
            const row = opts.projects?.[`${project}|${team}`];
            if (!row) return null;
            return (
              withCanonical ? row : { productionDeploymentId: row.productionDeploymentId }
            ) as T;
          }
          if (sql.includes("FROM deployment")) {
            d1Calls.push("branch");
            const [, , branch] = bound as [string, string, string];
            return (opts.branches?.includes(branch) ? { id: "dep_branch" } : null) as T | null;
          }
          if (sql.includes("FROM custom_domain")) {
            d1Calls.push(sql.includes("t.plan") ? "customPlan" : "customScript");
            const [hostname] = bound as [string];
            return (opts.customDomains?.[hostname] ?? null) as T | null;
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

let dispatched: string[];
let workerResponse: () => Response;

function makeEnv(opts: MockOptions) {
  return {
    DISPATCHER: {
      get(name: string) {
        dispatched.push(name);
        return { fetch: async () => workerResponse() };
      },
    },
    DB: createMockD1(opts),
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

const REDIRECTING: MockOptions = {
  projects: {
    "site|acme": {
      productionDeploymentId: "dep_1",
      redirectToPrimaryDomain: 1,
      primaryDomain: "app.example.com",
    },
  },
};

const SERVING_BOTH: MockOptions = {
  projects: {
    "site|acme": {
      productionDeploymentId: "dep_1",
      redirectToPrimaryDomain: 0,
      primaryDomain: "app.example.com",
    },
  },
};

const NO_DOMAIN: MockOptions = {
  projects: {
    "site|acme": {
      productionDeploymentId: "dep_1",
      redirectToPrimaryDomain: 1,
      primaryDomain: null,
    },
  },
};

describe("default hostname of a project with an active primary domain", () => {
  test("redirects 308 to the primary domain without dispatching", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv(REDIRECTING),
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://app.example.com/");
    expect(dispatched).toEqual([]);
  });

  test("keeps the path and query", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/docs/a%20b?x=1&y=%2F"),
      makeEnv(REDIRECTING),
    );

    expect(res.headers.get("Location")).toBe("https://app.example.com/docs/a%20b?x=1&y=%2F");
  });

  test("redirects to https even when the request arrived over http", async () => {
    const res = await worker.fetch(
      new Request("http://site-acme.bycreek.com/x"),
      makeEnv(REDIRECTING),
    );

    expect(res.headers.get("Location")).toBe("https://app.example.com/x");
  });

  test("drops a port the request carried", async () => {
    const res = await worker.fetch(
      new Request("http://site-acme.bycreek.com:8787/x"),
      makeEnv(REDIRECTING),
    );

    expect(res.headers.get("Location")).toBe("https://app.example.com/x");
  });

  test("answers a POST with 308 too, so the client replays the method and body", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/api/hook", { method: "POST", body: "{}" }),
      makeEnv(REDIRECTING),
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://app.example.com/api/hook");
  });

  test("bounds how long a client may reuse the redirect", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv(REDIRECTING),
    );

    // An uncached-by-header 308 is reused indefinitely, outliving a later
    // change of primary domain or the redirect being turned off.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  test("is decided from the route cache on a repeat request", async () => {
    const env = makeEnv(REDIRECTING);
    await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);
    d1Calls = [];

    const res = await worker.fetch(new Request("https://site-acme.bycreek.com/again"), env);

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://app.example.com/again");
    expect(d1Calls).toEqual([]);
  });

  test("costs one project lookup, not a second round trip", async () => {
    await worker.fetch(new Request("https://site-acme.bycreek.com/"), makeEnv(REDIRECTING));

    expect(d1Calls).toEqual(["orgs", "production"]);
  });

  test("stops redirecting within the route TTL once the redirect is turned off", async () => {
    vi.useFakeTimers();
    const opts: MockOptions = structuredClone(REDIRECTING);
    const env = makeEnv(opts);
    expect((await worker.fetch(new Request("https://site-acme.bycreek.com/"), env)).status).toBe(
      308,
    );

    opts.projects!["site|acme"]!.redirectToPrimaryDomain = 0;
    vi.advanceTimersByTime(61_000);
    const res = await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);

    expect(res.status).toBe(200);
    expect(dispatched).toEqual(["site-acme"]);
  });

  test("never redirects a host to itself", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv({
        projects: {
          "site|acme": {
            productionDeploymentId: "dep_1",
            redirectToPrimaryDomain: 1,
            primaryDomain: "site-acme.bycreek.com",
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dispatched).toEqual(["site-acme"]);
  });

  test("does not redirect a project with no production deployment", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv({
        projects: {
          "site|acme": {
            productionDeploymentId: null,
            redirectToPrimaryDomain: 1,
            primaryDomain: "app.example.com",
          },
        },
      }),
    );

    expect(res.status).toBe(404);
  });
});

describe("redirect turned off", () => {
  test("serves the default hostname, marked noindex", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv(SERVING_BOTH),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(dispatched).toEqual(["site-acme"]);
  });

  test("marks error responses too", async () => {
    workerResponse = () => new Response("nope", { status: 404 });

    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/missing"),
      makeEnv(SERVING_BOTH),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  test("keeps the tenant's own X-Robots-Tag", async () => {
    workerResponse = () => new Response("ok", { headers: { "X-Robots-Tag": "noarchive" } });

    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv(SERVING_BOTH),
    );

    expect(res.headers.get("X-Robots-Tag")).toBe("noarchive");
  });

  test("keeps the response's other headers and status text", async () => {
    workerResponse = () =>
      new Response("ok", {
        status: 201,
        statusText: "Created",
        headers: { "Content-Type": "text/plain", "Cache-Control": "max-age=60", ETag: '"v1"' },
      });

    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv(SERVING_BOTH),
    );

    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.headers.get("Cache-Control")).toBe("max-age=60");
    expect(res.headers.get("ETag")).toBe('"v1"');
  });

  test("passes a WebSocket upgrade through untouched", async () => {
    // A 101 cannot be rebuilt: the copy would lose its socket.
    const upgrade = {
      status: 101,
      ok: false,
      headers: new Headers({ Upgrade: "websocket" }),
    } as unknown as Response;
    workerResponse = () => upgrade;

    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/ws"),
      makeEnv(SERVING_BOTH),
    );

    expect(res).toBe(upgrade);
  });

  test("is still noindex from the route cache", async () => {
    const env = makeEnv(SERVING_BOTH);
    await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);
    d1Calls = [];

    const res = await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);

    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(d1Calls).toEqual([]);
  });
});

describe("project with no active primary domain", () => {
  test("serves the default hostname unmarked: it is the project's only address", async () => {
    const original = new Response("ok", { headers: { "Content-Type": "text/html" } });
    workerResponse = () => original;

    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv(NO_DOMAIN),
    );

    expect(res).toBe(original);
    expect(res.headers.has("X-Robots-Tag")).toBe(false);
  });
});

describe("previews", () => {
  test("a branch preview is noindex and never redirects", async () => {
    const res = await worker.fetch(
      new Request("https://site-git-feature-acme.bycreek.com/"),
      makeEnv({ ...REDIRECTING, branches: ["feature"] }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(dispatched).toEqual(["site-git-feature-acme"]);
  });

  test("a deployment preview is noindex and never redirects", async () => {
    const res = await worker.fetch(
      new Request("https://site-a1b2c3d4-acme.bycreek.com/"),
      makeEnv(REDIRECTING),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(dispatched).toEqual(["site-a1b2c3d4-acme"]);
  });

  test("a preview is noindex even for a project with no custom domain", async () => {
    const res = await worker.fetch(
      new Request("https://site-a1b2c3d4-acme.bycreek.com/"),
      makeEnv(NO_DOMAIN),
    );

    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

describe("the custom domain itself", () => {
  test("is served, never redirected or marked", async () => {
    const original = new Response("ok", { headers: { "Content-Type": "text/html" } });
    workerResponse = () => original;

    const res = await worker.fetch(
      new Request("https://app.example.com/"),
      makeEnv({
        ...REDIRECTING,
        customDomains: { "app.example.com": { slug: "site", team_slug: "acme", plan: "pro" } },
      }),
    );

    expect(res).toBe(original);
    expect(res.headers.has("X-Robots-Tag")).toBe(false);
    expect(dispatched).toEqual(["site-acme"]);
  });
});

describe("before migration 0014", () => {
  test("serves the default hostname with no redirect and no noindex", async () => {
    const original = new Response("ok", { headers: { "Content-Type": "text/html" } });
    workerResponse = () => original;

    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv({ ...REDIRECTING, preMigration: true }),
    );

    expect(res).toBe(original);
    expect(d1Calls).toEqual(["orgs", "production", "productionLegacy"]);
  });

  test("still 404s an unknown project", async () => {
    const res = await worker.fetch(
      new Request("https://ghost-acme.bycreek.com/"),
      makeEnv({ ...REDIRECTING, preMigration: true }),
    );

    expect(res.status).toBe(404);
  });

  test("any other lookup failure is a 503, not a silent fallback", async () => {
    const res = await worker.fetch(
      new Request("https://site-acme.bycreek.com/"),
      makeEnv({ ...REDIRECTING, productionError: "Network connection lost." }),
    );

    expect(res.status).toBe(503);
    expect(d1Calls).toEqual(["orgs", "production"]);
    expect(dispatched).toEqual([]);
  });
});
