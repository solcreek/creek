/**
 * Production serves the deployment Creek calls production.
 *
 * A production hostname (and a project's custom domain) dispatches to the
 * immutable `{project}-{shortId}-{team}` script of the deployment that
 * `project.productionDeploymentId` points at. Promote and rollback only move
 * that pointer, so this is what makes them change what a visitor sees
 * (formal/production-serving, findings 1-3).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type workerModule from "./index.js";

interface State {
  /** project slug → productionDeploymentId */
  pointers: Record<string, string | null>;
  /** custom hostname → project slug */
  customDomains: Record<string, string>;
}

let dispatched: string[];
let worker: typeof workerModule;

function makeEnv(state: State) {
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const exec = {
        bind(...args: unknown[]) {
          bound = args;
          return exec;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("cd.hostname = ?")) {
            const slug = state.customDomains[bound[0] as string];
            if (!slug) return null;
            return {
              slug,
              team_slug: "acme",
              productionDeploymentId: state.pointers[slug] ?? null,
            } as T;
          }
          if (sql.includes("FROM custom_domain") && sql.includes("t.plan")) {
            return { plan: "pro" } as T;
          }
          if (sql.includes("p.productionDeploymentId")) {
            const [project, team] = bound as [string, string];
            if (team !== "acme" || !(project in state.pointers)) return null;
            return { productionDeploymentId: state.pointers[project] } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM organization")) {
            return { results: [{ slug: "acme", plan: "pro" }] as unknown as T[] };
          }
          return { results: [] };
        },
      };
      return exec;
    },
  } as unknown as D1Database;

  return {
    DISPATCHER: {
      get(name: string) {
        dispatched.push(name);
        return { fetch: async () => new Response(name) };
      },
    },
    DB: db,
    CREEK_DOMAIN: "bycreek.com",
  } as unknown as Parameters<typeof workerModule.fetch>[1];
}

const DEPLOY_1 = "1111aaaa-0000-4000-8000-000000000001";
const DEPLOY_2 = "2222bbbb-0000-4000-8000-000000000002";

beforeEach(async () => {
  dispatched = [];
  vi.resetModules();
  worker = (await import("./index.js")).default;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("production follows productionDeploymentId", () => {
  test("the default hostname serves the immutable script of the production deployment", async () => {
    const env = makeEnv({ pointers: { site: DEPLOY_2 }, customDomains: {} });
    const res = await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);

    expect(res.status).toBe(200);
    expect(dispatched).toEqual(["site-2222bbbb-acme"]);
  });

  test("a custom domain serves the same deployment", async () => {
    const env = makeEnv({
      pointers: { site: DEPLOY_2 },
      customDomains: { "app.example.com": "site" },
    });
    await worker.fetch(new Request("https://app.example.com/"), env);

    expect(dispatched).toEqual(["site-2222bbbb-acme"]);
  });

  test("moving the pointer (rollback, promote) changes what is served once the route cache expires", async () => {
    vi.useFakeTimers();
    const state: State = {
      pointers: { site: DEPLOY_2 },
      customDomains: { "app.example.com": "site" },
    };
    const env = makeEnv(state);

    await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);
    await worker.fetch(new Request("https://app.example.com/"), env);

    state.pointers.site = DEPLOY_1; // POST /projects/site/rollback
    vi.advanceTimersByTime(61_000);

    await worker.fetch(new Request("https://site-acme.bycreek.com/"), env);
    await worker.fetch(new Request("https://app.example.com/"), env);

    expect(dispatched).toEqual([
      "site-2222bbbb-acme",
      "site-2222bbbb-acme",
      "site-1111aaaa-acme",
      "site-1111aaaa-acme",
    ]);
  });

  test("a custom domain of a project with no production deployment is 404, not dispatched", async () => {
    const env = makeEnv({ pointers: { site: null }, customDomains: { "app.example.com": "site" } });
    const res = await worker.fetch(new Request("https://app.example.com/"), env);

    expect(res.status).toBe(404);
    expect(dispatched).toEqual([]);
  });
});

// Slugs may end in eight hex characters or contain `-git-`, so a project's own
// default hostname can parse as a preview. It must follow its own pointer.
describe("a project whose slug looks like a preview", () => {
  test.each([
    ["eight hex characters", "site-a1b2c3d4"],
    ["-git-", "app-git-feature"],
  ])("a slug ending in %s serves its production deployment", async (_, slug) => {
    vi.useFakeTimers();
    const state: State = { pointers: { [slug]: DEPLOY_2 }, customDomains: {} };
    const env = makeEnv(state);
    await worker.fetch(new Request(`https://${slug}-acme.bycreek.com/`), env);

    state.pointers[slug] = DEPLOY_1; // rollback
    vi.advanceTimersByTime(61_000);
    await worker.fetch(new Request(`https://${slug}-acme.bycreek.com/`), env);

    expect(dispatched).toEqual([`${slug}-2222bbbb-acme`, `${slug}-1111aaaa-acme`]);
  });

  test("such a project with no production deployment is 404, not its mutable script", async () => {
    const env = makeEnv({ pointers: { "site-a1b2c3d4": null }, customDomains: {} });
    const res = await worker.fetch(new Request("https://site-a1b2c3d4-acme.bycreek.com/"), env);

    expect(res.status).toBe(404);
    expect(dispatched).toEqual([]);
  });

  test("with no such project, the hostname is still the deployment preview", async () => {
    const env = makeEnv({ pointers: { site: DEPLOY_2 }, customDomains: {} });
    await worker.fetch(new Request("https://site-a1b2c3d4-acme.bycreek.com/"), env);

    expect(dispatched).toEqual(["site-a1b2c3d4-acme"]);
  });
});
