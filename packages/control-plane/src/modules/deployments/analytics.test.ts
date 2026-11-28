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

  // Production traffic runs on the production deployment's own script, so the
  // query must cover those scripts, not only `{project}-{team}`.
  test("queries the production deployments' scripts, not previews or rollback records", async () => {
    const projectId = seedProject(testEnv, "my-app");
    const now = Date.now();
    const insert = (
      id: string,
      branch: string | null,
      status: string,
      trigger: string,
      at: number,
    ) =>
      testEnv.db.db.exec(
        `INSERT INTO deployment (id, projectId, version, status, branch, triggerType, createdAt, updatedAt)
         VALUES ('${id}', '${projectId}', 1, '${status}', ${branch === null ? "NULL" : `'${branch}'`}, '${trigger}', ${at}, ${at})`,
      );
    insert("aaaa1111-old-prod", null, "active", "cli", now - 3000);
    insert("bbbb2222-new-prod", "main", "active", "github", now - 2000);
    insert("cccc3333-feature", "feature-x", "active", "github", now - 1000);
    insert("dddd4444-failed", "main", "failed", "cli", now - 500);
    insert("eeee5555-rollback", null, "active", "rollback", now);
    testEnv.db.db.exec(
      `UPDATE project SET productionDeploymentId = 'aaaa1111-old-prod' WHERE id = '${projectId}'`,
    );

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { viewer: { accounts: [{ series: [], totals: [] }] } } }),
        ),
      );

    const res = await req("/projects/my-app/analytics");
    const json = (await res.json()) as any;
    const team = TEST_TEAM.slug;
    expect(json.scriptNames).toEqual([
      `my-app-${team}`,
      `my-app-bbbb2222-${team}`,
      `my-app-aaaa1111-${team}`,
    ]);
    const query = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body).query as string;
    expect(query).toContain(`scriptName_in: ${JSON.stringify(json.scriptNames)}`);
    expect(query).not.toContain(`scriptName: "`);
  });

  test("falls back to the production script alone if Cloudflare refuses the list filter", async () => {
    seedProject(testEnv, "my-app");
    const ok = {
      data: {
        viewer: {
          accounts: [
            {
              series: [],
              totals: [
                {
                  sum: { requests: 7, errors: 0, subrequests: 0 },
                  quantiles: { cpuTimeP50: 1, cpuTimeP99: 2 },
                },
              ],
            },
          ],
        },
      },
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: null, errors: [{ message: "unknown field scriptName_in" }] }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(ok)));

    const json = (await (await req("/projects/my-app/analytics")).json()) as any;
    expect(json.totals.requests).toBe(7);
    expect(json.scriptNames).toEqual([`my-app-${TEST_TEAM.slug}`]);
    const second = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body).query as string;
    expect(second).toContain(`scriptName: "my-app-${TEST_TEAM.slug}"`);
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
