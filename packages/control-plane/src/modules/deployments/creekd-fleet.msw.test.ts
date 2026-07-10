import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { creekdFleetTarget } from "./creekd-fleet.js";
import type { DeployAssetsInput } from "./deploy.js";
import type { Env } from "../../types.js";

// Drives CreekdFleetTarget.deploy against a mocked creekd admin API (MSW).
// Asserts the creekd control interaction: correct SpawnRequest body + bearer
// auth on POST /v1/apps, the 409-already_running → blue-green /deploy fallback,
// health polling via dispatch, and error/misconfig handling. Fabricated IDs.

const ADMIN = "http://creekd.test:9080";
const DISPATCH = "http://creekd.test:9000";

let spawnBodies: Array<Record<string, unknown>> = [];
let spawnAuth: string | null = null;
let deployCalls: Array<{ id: string; body: Record<string, unknown> }> = [];
let healthHeaders: Array<string | null> = [];

const okSpawn = http.post(`${ADMIN}/v1/apps`, async ({ request }) => {
  spawnAuth = request.headers.get("authorization");
  spawnBodies.push((await request.json()) as Record<string, unknown>);
  return HttpResponse.json({ id: "ok" }, { status: 201 });
});
const okDeploy = http.post(`${ADMIN}/v1/apps/:id/deploy`, async ({ request, params }) => {
  deployCalls.push({ id: String(params.id), body: (await request.json()) as Record<string, unknown> });
  return HttpResponse.json({ id: "ok" }, { status: 200 });
});
const okHealth = http.get(`${DISPATCH}/health`, ({ request }) => {
  healthHeaders.push(request.headers.get("x-creek-app"));
  return new HttpResponse("ok", { status: 200 });
});

const server = setupServer(okSpawn, okDeploy, okHealth);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  spawnBodies = [];
  spawnAuth = null;
  deployCalls = [];
  healthHeaders = [];
  server.resetHandlers();
});
afterAll(() => server.close());

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DEPLOY_TARGET: "creekd-fleet",
    CREEKD_ADMIN_URL: ADMIN,
    CREEKD_DISPATCH_URL: DISPATCH,
    CREEKD_TOKEN: "test-token",
    ...overrides,
  } as Env;
}

const input = {} as DeployAssetsInput; // CreekdFleetTarget ignores the CF-shaped input

describe("CreekdFleetTarget.deploy", () => {
  it("spawns the app on creekd with the right SpawnRequest + bearer auth, then waits healthy", async () => {
    await creekdFleetTarget.deploy(makeEnv(), "acme", "myteam", "dep_123", input);

    expect(spawnAuth).toBe("Bearer test-token");
    expect(spawnBodies).toHaveLength(1);
    const body = spawnBodies[0];
    expect(body.id).toBe("acme-myteam");
    expect(body.command).toBe("bun");
    expect(body.args).toEqual(["server.js"]);
    expect(body.health_check_path).toBe("/health");
    expect(typeof body.port).toBe("number");
    const envList = body.env as string[];
    expect(envList).toContain(`PORT=${body.port}`);
    expect(envList).toContain("JUNE_PROJECT=acme");
    expect(envList).toContain("JUNE_TEAM=myteam");
    expect(envList).toContain("JUNE_DEPLOYMENT=dep_123");

    // health polled via dispatch with the x-creek-app header = the app id
    expect(healthHeaders).toContain("acme-myteam");
    // no redeploy on a fresh spawn
    expect(deployCalls).toHaveLength(0);
  });

  it("uses configurable command/entry", async () => {
    await creekdFleetTarget.deploy(
      makeEnv({ CREEKD_JUNE_COMMAND: "node", CREEKD_JUNE_ENTRY: "dist/index.js" }),
      "acme",
      "myteam",
      "dep_1",
      input,
    );
    expect(spawnBodies[0].command).toBe("node");
    expect(spawnBodies[0].args).toEqual(["dist/index.js"]);
  });

  it("blue-green redeploys when the app already exists (409 already_running)", async () => {
    server.use(
      http.post(`${ADMIN}/v1/apps`, () =>
        HttpResponse.json({ code: "already_running", error: "app acme-myteam is already running" }, {
          status: 409,
        }),
      ),
    );

    await creekdFleetTarget.deploy(makeEnv(), "acme", "myteam", "dep_2", input);

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0].id).toBe("acme-myteam");
    expect(deployCalls[0].body.health_check_path).toBe("/health");
    expect(healthHeaders).toContain("acme-myteam");
  });

  it("throws a clear error when CREEKD_ADMIN_URL is missing", async () => {
    await expect(
      creekdFleetTarget.deploy(makeEnv({ CREEKD_ADMIN_URL: undefined }), "acme", "myteam", "d", input),
    ).rejects.toThrow(/CREEKD_ADMIN_URL/);
  });

  it("propagates a creekd spawn error (non-409)", async () => {
    server.use(
      http.post(`${ADMIN}/v1/apps`, () =>
        HttpResponse.json({ code: "port_conflict", error: "port 30000 in use" }, { status: 409 }),
      ),
    );
    await expect(
      creekdFleetTarget.deploy(makeEnv(), "acme", "myteam", "d", input),
    ).rejects.toThrow(/creekd spawn failed.*port_conflict/);
  });

  it("skips health polling when no dispatch URL is configured", async () => {
    await creekdFleetTarget.deploy(makeEnv({ CREEKD_DISPATCH_URL: undefined }), "acme", "myteam", "d", input);
    expect(spawnBodies).toHaveLength(1);
    expect(healthHeaders).toHaveLength(0);
  });
});
