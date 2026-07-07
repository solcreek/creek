import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
});

afterEach(() => {
  testEnv.cleanup();
  globalThis.fetch = originalFetch;
});

function req(path: string) {
  return app.request(path, { method: "GET" }, testEnv.env);
}

describe("GET /projects/:id/analytics", () => {
  test("returns 404 for unknown project", async () => {
    const res = await req("/projects/unknown/analytics");
    expect(res.status).toBe(404);
  });

  test("returns totals and series for valid project", async () => {
    seedProject(testEnv, "my-app");

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                {
                  series: [
                    {
                      dimensions: {
                        datetimeFifteenMinutes: "2026-04-09T10:00:00Z",
                        status: "success",
                      },
                      sum: { requests: 42, errors: 0, subrequests: 10 },
                      quantiles: { cpuTimeP50: 1.2, cpuTimeP99: 5.8 },
                    },
                    {
                      dimensions: {
                        datetimeFifteenMinutes: "2026-04-09T10:15:00Z",
                        status: "success",
                      },
                      sum: { requests: 18, errors: 2, subrequests: 4 },
                      quantiles: { cpuTimeP50: 1.5, cpuTimeP99: 8.1 },
                    },
                  ],
                  totals: [
                    {
                      sum: { requests: 60, errors: 2, subrequests: 14 },
                      quantiles: { cpuTimeP50: 1.3, cpuTimeP99: 6.5 },
                    },
                  ],
                },
              ],
            },
          },
        }),
      ),
    );

    const res = await req("/projects/my-app/analytics");
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.period).toBe("24h");
    expect(json.scriptName).toBe(`my-app-${TEST_TEAM.slug}`);
    expect(json.totals.requests).toBe(60);
    expect(json.totals.errors).toBe(2);
    expect(json.series).toHaveLength(2);
    expect(json.series[0].requests).toBe(42);
  });

  test("accepts period=7d query param", async () => {
    seedProject(testEnv, "my-app");

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { viewer: { accounts: [{ series: [], totals: [] }] } },
        }),
      ),
    );

    const res = await req("/projects/my-app/analytics?period=7d");
    const json = (await res.json()) as any;
    expect(json.period).toBe("7d");

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.query).toContain("datetimeHour");
  });

  test("returns empty data when CF API fails", async () => {
    seedProject(testEnv, "my-app");

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const res = await req("/projects/my-app/analytics");
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.totals.requests).toBe(0);
    expect(json.series).toEqual([]);
  });
});

describe("GET /projects/:id/cron-logs", () => {
  test("returns 404 for unknown project", async () => {
    const res = await req("/projects/unknown/cron-logs");
    expect(res.status).toBe(404);
  });

  test("returns invocations for valid project", async () => {
    seedProject(testEnv, "cron-app");

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      dimensions: {
                        datetime: "2026-04-09T12:00:00Z",
                        status: "success",
                        scriptName: "cron-app",
                      },
                      sum: { requests: 1, errors: 0, duration: 15 },
                    },
                  ],
                },
              ],
            },
          },
        }),
      ),
    );

    const res = await req("/projects/cron-app/cron-logs");
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.invocations).toHaveLength(1);
    expect(json.invocations[0].requests).toBe(1);
    expect(json.invocations[0].durationMs).toBe(15);
  });

  test("returns empty on CF API failure", async () => {
    seedProject(testEnv, "app");

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

    const res = await req("/projects/app/cron-logs");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.invocations).toEqual([]);
  });
});
