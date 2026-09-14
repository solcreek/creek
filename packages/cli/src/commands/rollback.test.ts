import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rollbackCommand } from "./rollback.js";

const API = "https://cp.test";
const SLUG = "myproj";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let stdout: string;
let testDir: string;
let prevCwd: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok-test";
  testDir = join(
    tmpdir(),
    `creek-rollback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "creek.toml"), `[project]\nname = "${SLUG}"\n`);
  prevCwd = process.cwd();
  process.chdir(testDir);
});
afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
  rmSync(testDir, { recursive: true, force: true });
});

async function runExit(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error("expected the command to call process.exit");
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}
function json() {
  return JSON.parse(stdout);
}

function deployment(id: string, status: string, createdAt: number, triggerType: string = "cli") {
  return {
    id,
    projectId: "p1",
    version: createdAt,
    status,
    branch: "main",
    commitSha: null,
    commitMessage: null,
    triggerType,
    failedStep: null,
    errorMessage: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function projectHandler(productionDeploymentId: string | null) {
  return http.get(`${API}/projects/${SLUG}`, () =>
    HttpResponse.json({
      id: "p1",
      slug: SLUG,
      productionDeploymentId,
    }),
  );
}

function listHandler(...rows: ReturnType<typeof deployment>[]) {
  return http.get(`${API}/projects/${SLUG}/deployments`, () => HttpResponse.json(rows));
}

function planHandler(
  currentDeploymentId: string | null,
  target: { id: string; status: string } | null = null,
) {
  return http.get(`${API}/projects/${SLUG}/rollback`, () =>
    HttpResponse.json({
      currentDeploymentId,
      targetDeploymentId: target?.id ?? null,
      targetStatus: target?.status ?? null,
    }),
  );
}

async function dryRun(extra: Record<string, unknown> = {}): Promise<number> {
  return runExit(
    (rollbackCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { "dry-run": true, json: true, ...extra },
    }),
  );
}

describe("creek rollback --dry-run", () => {
  it("does not POST rollback and names the previous deployment", async () => {
    let posted = false;
    server.use(
      projectHandler("dep-new"),
      planHandler("dep-new", { id: "dep-old", status: "active" }),
      http.post(`${API}/projects/${SLUG}/rollback`, () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const code = await dryRun();
    expect(code).toBe(0);
    expect(posted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      currentDeploymentId: "dep-new",
      targetDeploymentId: "dep-old",
    });
    expect(json().nextStep).toBe(`creek rollback dep-old --project ${SLUG} --json`);
  });

  it("keeps a quoted --message on nextStep", async () => {
    server.use(
      projectHandler("dep-new"),
      planHandler("dep-new", { id: "dep-old", status: "active" }),
    );
    const code = await dryRun({ message: 'roll back the "outage"' });
    expect(code).toBe(0);
    expect(json().nextStep).toBe(
      `creek rollback dep-old --project ${SLUG} --message 'roll back the "outage"' --json`,
    );
  });

  it("uses production_deployment_id, not the newest active row, as current", async () => {
    server.use(
      projectHandler("dep-old"),
      planHandler("dep-old", { id: "dep-rollback", status: "active" }),
    );
    const code = await dryRun();
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      wouldExecute: true,
      currentDeploymentId: "dep-old",
      targetDeploymentId: "dep-rollback",
    });
  });

  it("implicit previous skips synthetic triggerType=rollback rows", async () => {
    server.use(
      projectHandler("dep-rb-2"),
      planHandler("dep-rb-2", { id: "dep-real", status: "active" }),
    );
    const code = await dryRun();
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      wouldExecute: true,
      currentDeploymentId: "dep-rb-2",
      targetDeploymentId: "dep-real",
    });
    expect(json().nextStep).toBe(`creek rollback dep-real --project ${SLUG} --json`);
  });

  it("wouldExecute is false when the explicit target is already production", async () => {
    server.use(
      projectHandler("dep-new"),
      listHandler(deployment("dep-new", "active", 200), deployment("dep-old", "active", 100)),
    );
    const code = await dryRun({ deployment: "dep-new" });
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      wouldExecute: false,
      currentDeploymentId: "dep-new",
      targetDeploymentId: "dep-new",
    });
  });

  it("wouldExecute is false when the explicit target is not active", async () => {
    server.use(
      projectHandler("dep-new"),
      listHandler(deployment("dep-new", "active", 200), deployment("dep-failed", "failed", 100)),
    );
    const code = await dryRun({ deployment: "dep-failed" });
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      wouldExecute: false,
      targetDeploymentId: "dep-failed",
      targetStatus: "failed",
    });
  });

  it("wouldExecute is false when the previous deployment is not active", async () => {
    server.use(projectHandler("dep-new"), planHandler("dep-new"));
    const code = await dryRun();
    expect(code).toBe(0);
    expect(json()).toMatchObject({ wouldExecute: false, currentDeploymentId: "dep-new" });
  });

  it("resolves an explicit id missing from the truncated list via GET", async () => {
    let posted = false;
    server.use(
      projectHandler("dep-new"),
      listHandler(deployment("dep-new", "active", 200)),
      http.get(`${API}/projects/${SLUG}/deployments/dep-old`, () =>
        HttpResponse.json({
          deployment: deployment("dep-old", "active", 100),
          url: null,
          previewUrl: "https://preview.test",
        }),
      ),
      http.post(`${API}/projects/${SLUG}/rollback`, () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await dryRun({ deployment: "dep-old" });
    expect(code).toBe(0);
    expect(posted).toBe(false);
    expect(json()).toMatchObject({
      wouldExecute: true,
      currentDeploymentId: "dep-new",
      targetDeploymentId: "dep-old",
    });
  });

  it("wouldExecute is false when the explicit id is not in the list and GET 404s", async () => {
    server.use(
      projectHandler("dep-new"),
      listHandler(deployment("dep-new", "active", 200)),
      http.get(`${API}/projects/${SLUG}/deployments/dep-missing`, () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    const code = await dryRun({ deployment: "dep-missing" });
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      wouldExecute: false,
      targetDeploymentId: null,
    });
  });

  it("emits api_error when the rollback plan fails", async () => {
    server.use(
      projectHandler("dep-new"),
      http.get(`${API}/projects/${SLUG}/rollback`, () => new HttpResponse(null, { status: 500 })),
    );
    const code = await dryRun();
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "api_error" });
  });

  it("implicit previous uses the server plan, not the 20-row list page", async () => {
    const rollbackPage = Array.from({ length: 20 }, (_, i) =>
      deployment(`dep-rb-${i}`, "active", 400 - i, "rollback"),
    );
    let listed = false;
    server.use(
      projectHandler("dep-rb-0"),
      http.get(`${API}/projects/${SLUG}/deployments`, () => {
        listed = true;
        return HttpResponse.json(rollbackPage);
      }),
      planHandler("dep-rb-0", { id: "dep-real", status: "active" }),
    );
    const code = await dryRun();
    expect(code).toBe(0);
    expect(listed).toBe(false);
    expect(json()).toMatchObject({
      wouldExecute: true,
      currentDeploymentId: "dep-rb-0",
      targetDeploymentId: "dep-real",
    });
  });
});
