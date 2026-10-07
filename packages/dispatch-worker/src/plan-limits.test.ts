/**
 * The dispatch Worker applies the team's plan limits to every user worker it
 * dispatches, and turns a limit hit into a 429 that names the plan's ceiling
 * and the next plan up. Each test re-imports the worker module: the team and
 * route caches are module-level, so a fresh module keeps one test's plan from
 * leaking into the next.
 */

import { describe, test, expect, vi } from "vitest";
import { PLAN_LIMITS } from "./parse.js";

type Limits = { cpuMs?: number; subRequests?: number } | undefined;

function makeEnv(opts: {
  plan: string;
  /** Custom-domain team plan; a custom domain resolves the plan separately. */
  customDomain?: boolean;
  /** What the user worker does: return a response, or throw this message. */
  workerThrows?: string;
}) {
  const calls: Array<{ name: string; limits: Limits }> = [];
  const db = {
    prepare(sql: string) {
      const exec = {
        bind() {
          return exec;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("p.productionDeploymentId")) {
            return { productionDeploymentId: "dep_1" } as T;
          }
          if (sql.includes("FROM custom_domain")) {
            return (
              sql.includes("t.plan") ? { plan: opts.plan } : { slug: "shop", team_slug: "acme" }
            ) as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM organization")) {
            return { results: [{ slug: "acme", plan: opts.plan }] as T[] };
          }
          return { results: [] };
        },
      };
      return exec;
    },
  };
  const env = {
    DB: db,
    CREEK_DOMAIN: "bycreek.com",
    DISPATCHER: {
      get(name: string, _meta?: unknown, options?: { limits?: Limits }) {
        calls.push({ name, limits: options?.limits });
        return {
          async fetch(): Promise<Response> {
            if (opts.workerThrows) throw new Error(opts.workerThrows);
            return new Response("ok");
          },
        };
      },
    },
  } as unknown as Parameters<Awaited<typeof import("./index.js")>["default"]["fetch"]>[1];
  const url = opts.customDomain ? "https://shop.example.com/" : "https://shop-acme.bycreek.com/";
  return { env, calls, request: new Request(url) };
}

async function loadWorker() {
  vi.resetModules();
  return (await import("./index.js")).default;
}

describe("dispatch applies the team's plan limits", () => {
  test.each(["free", "starter", "pro", "enterprise"] as const)(
    "%s team's worker runs with %s limits",
    async (plan) => {
      const worker = await loadWorker();
      const { env, calls, request } = makeEnv({ plan });
      const res = await worker.fetch(request, env);
      expect(res.status).toBe(200);
      expect(calls).toEqual([{ name: "shop-acme", limits: PLAN_LIMITS[plan] }]);
    },
  );

  test("a custom domain uses its team's plan", async () => {
    const worker = await loadWorker();
    const { env, calls, request } = makeEnv({ plan: "pro", customDomain: true });
    await worker.fetch(request, env);
    expect(calls[0]?.limits).toEqual(PLAN_LIMITS.pro);
  });

  test("an unknown plan runs with free limits", async () => {
    const worker = await loadWorker();
    const { env, calls, request } = makeEnv({ plan: "legacy-beta" });
    await worker.fetch(request, env);
    expect(calls[0]?.limits).toEqual(PLAN_LIMITS.free);
  });
});

describe("a limit hit becomes a 429 naming the ceiling and the next plan", () => {
  test("CPU limit on free", async () => {
    const worker = await loadWorker();
    const { env, request } = makeEnv({
      plan: "free",
      workerThrows: "Worker exceeded CPU time limit.",
    });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: "cpu_limit_exceeded",
      message: "CPU time limit exceeded (5000ms on free plan).",
      upgrade: "Upgrade to Starter for higher limits.",
    });
  });

  test("subrequest limit on pro points at Enterprise", async () => {
    const worker = await loadWorker();
    const { env, request } = makeEnv({
      plan: "pro",
      workerThrows: "Too many subrequests: exceeded the subrequest limit",
    });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "subrequest_limit_exceeded",
      message: "Subrequest limit exceeded (5000 on pro plan).",
      upgrade: "Contact us about Enterprise for higher limits.",
    });
  });

  test("any other worker error is still a 500", async () => {
    const worker = await loadWorker();
    const { env, request } = makeEnv({ plan: "free", workerThrows: "boom" });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(500);
  });
});
