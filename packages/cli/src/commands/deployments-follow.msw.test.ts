import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentsCommand } from "./deployments.js";
import { statusCommand } from "./status.js";
import { reportWaitTimeout } from "./deploy.js";
import { printDeployment } from "../utils/deployment-follow.js";
import { toDeploymentView } from "@solcreek/sdk";
import consola from "consola";
import { AUTH_BREADCRUMBS } from "../utils/output.js";

// Following a deploy to its result with one id: `deployments get`,
// `deployments wait` and `status <id>`. Same harness as commands.msw.test.ts:
// MSW for HTTP, process.exit stubbed to throw, stdout captured. Fabricated ids.
const SBX = "https://sandbox.test";
const API = "https://cp.test";
const FULL = "0123abcd-0000-4000-8000-000000000001";
const SHORT = "0123abcd";

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
let dir: string;
let prevCwd: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  });
  process.env.CREEK_SANDBOX_API_URL = SBX;
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok";
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "creek-follow-"));
  writeFileSync(join(dir, "creek.toml"), '[project]\nname = "site"\n');
  process.chdir(dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CREEK_SANDBOX_API_URL;
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
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
const json = () => JSON.parse(stdout);
const commands = () => json().breadcrumbs.map((b: { command: string }) => b.command);

type Cmd = { run?: (c: never) => unknown };
const sub = (name: string) => (deploymentsCommand.subCommands as Record<string, Cmd>)[name];

function deployment(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    deployment: {
      id: FULL,
      projectId: "p1",
      version: 7,
      status: "deploying",
      branch: "main",
      commitSha: "abc1234def56",
      triggerType: "cli",
      failedStep: null,
      errorMessage: null,
      createdAt: 1000,
      ...over,
    },
    url: null,
    previewUrl: `https://site-${SHORT}-team.test`,
    ...extra,
  };
}

function serve(...bodies: ReturnType<typeof deployment>[]) {
  let i = 0;
  server.use(
    http.get(`${API}/projects/site/deployments`, () =>
      HttpResponse.json([{ id: FULL, status: "deploying" }]),
    ),
    http.get(`${API}/projects/site/deployments/${FULL}`, () =>
      HttpResponse.json(bodies[Math.min(i++, bodies.length - 1)]),
    ),
  );
}

describe("creek deployments get <id>", () => {
  it("resolves a short id and returns the MCP get_deployment fields", async () => {
    serve(
      deployment(
        { status: "failed", failedStep: "activate", errorMessage: "script too large" },
        { errorCode: "CK-SIZE", errorHint: "Shrink the bundle" },
      ),
    );
    const code = await runExit(sub("get").run!({ args: { id: SHORT } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      project: "site",
      projectSource: "creek.toml",
      deploymentId: FULL,
      status: "failed",
      terminal: true,
      final: true,
      failedStep: "activate",
      errorCode: "CK-SIZE",
      errorHint: "Shrink the bundle",
      branch: "main",
      commitSha: "abc1234def56",
      url: null,
    });
    expect(commands()).toContain(`creek deployments logs ${FULL} --json`);
  });

  it("points an in-progress deployment at a pasteable wait", async () => {
    // Not the cwd's project, so the follow-up carries --project.
    server.use(
      http.get(`${API}/projects/other-dir-project/deployments/${FULL}`, () =>
        HttpResponse.json(deployment()),
      ),
    );
    await runExit(sub("get").run!({ args: { id: FULL, project: "other-dir-project" } } as never));
    expect(json()).toMatchObject({ final: false, status: "deploying" });
    expect(commands()[0]).toBe(`creek deployments wait ${FULL} --project other-dir-project --json`);
  });

  it("a path-traversal id is invalid_id and sends no request", async () => {
    // No handlers: MSW fails the test on any request.
    const id = "../../../../../../../api/auth/get-session";
    const code = await runExit(sub("get").run!({ args: { id } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "invalid_id" });
  });

  it("an unknown short id is not_found", async () => {
    serve(deployment());
    const code = await runExit(sub("get").run!({ args: { id: "ffffffff" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("creek deployments wait <id>", () => {
  it("exits 0 once the deployment is active", async () => {
    serve(deployment({ status: "active" }, { url: "https://site-team.test" }));
    const code = await runExit(sub("wait").run!({ args: { id: FULL } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      status: "active",
      final: true,
      url: "https://site-team.test",
    });
    expect(typeof json().waitedMs).toBe("number");
  });

  it("a failed deploy exits 1 with deployment_failed and the failure details", async () => {
    serve(
      deployment(
        { status: "failed", failedStep: "build", errorMessage: "tsc failed" },
        { errorCode: "CK-BUILD", errorHint: "Fix the type errors" },
      ),
    );
    const code = await runExit(sub("wait").run!({ args: { id: SHORT } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "deployment_failed",
      deploymentId: FULL,
      failedStep: "build",
      errorCode: "CK-BUILD",
      errorHint: "Fix the type errors",
    });
    expect(commands()).toContain(`creek deployments logs ${FULL} --json`);
  });

  it("a cancelled deploy exits 1 with deployment_cancelled", async () => {
    serve(deployment({ status: "cancelled" }));
    const code = await runExit(sub("wait").run!({ args: { id: FULL } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "deployment_cancelled" });
  });

  it("stops at --timeout with error timeout, retryable, the last status and a pasteable wait", async () => {
    serve(deployment({ status: "deploying" }));
    const code = await runExit(sub("wait").run!({ args: { id: SHORT, timeout: "1s" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "timeout",
      retryable: true,
      deploymentId: FULL,
      status: "deploying",
      final: false,
    });
    expect(commands()[0]).toBe(`creek deployments wait ${FULL} --json`);
  });

  it("rides out a 502 and keeps waiting", async () => {
    let reads = 0;
    server.use(
      http.get(`${API}/projects/site/deployments/${FULL}`, () =>
        ++reads === 1
          ? HttpResponse.json({ error: "bad_gateway", message: "Bad Gateway" }, { status: 502 })
          : HttpResponse.json(deployment({ status: "active" })),
      ),
    );
    const code = await runExit(sub("wait").run!({ args: { id: FULL, timeout: "10s" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, status: "active" });
  });

  it("a server error that lasts to --timeout is retryable, with the wait to paste", async () => {
    server.use(
      http.get(`${API}/projects/site/deployments/${FULL}`, () =>
        HttpResponse.json(
          { error: "unavailable", message: "Service Unavailable" },
          { status: 503 },
        ),
      ),
    );
    const code = await runExit(sub("wait").run!({ args: { id: FULL, timeout: "1s" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "api_error",
      retryable: true,
      deploymentId: FULL,
      status: 503,
    });
    expect(commands()).toEqual([`creek deployments wait ${FULL} --json`]);
  });

  it("a timeout before the first read finishes still says final: false", async () => {
    server.use(
      http.get(`${API}/projects/site/deployments/${FULL}`, async () => {
        await delay(5000);
        return HttpResponse.json(deployment());
      }),
    );
    const code = await runExit(sub("wait").run!({ args: { id: FULL, timeout: "1s" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "timeout",
      retryable: true,
      deploymentId: FULL,
      status: null,
      terminal: false,
      final: false,
    });
  });

  it("signed out, get and wait say how to log in, like list and logs", async () => {
    process.env.CREEK_TOKEN = "";
    for (const name of ["get", "wait"]) {
      stdout = "";
      const code = await runExit(sub(name).run!({ args: { id: FULL } } as never));
      expect(code).toBe(1);
      expect(json()).toMatchObject({
        ok: false,
        error: "not_authenticated",
        message: "Not authenticated. Run `creek login` first.",
        breadcrumbs: AUTH_BREADCRUMBS,
      });
    }
  });

  it("rejects an unparseable --timeout before any request", async () => {
    const code = await runExit(sub("wait").run!({ args: { id: FULL, timeout: "soon" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "invalid_timeout" });
  });
});

describe("creek deployments (no subcommand) lists", () => {
  // The parent's run() skips the list only when the args name a subcommand.
  for (const project of ["get", "wait", "logs", "list", "constructor"]) {
    it(`with --project ${project}, an option value, not a subcommand`, async () => {
      server.use(http.get(`${API}/projects/${project}/deployments`, () => HttpResponse.json([])));
      const code = await runExit(
        deploymentsCommand.run!({
          args: { project },
          rawArgs: ["--project", project, "--json"],
        } as never),
      );
      expect(code).toBe(0);
      expect(json()).toMatchObject({ ok: true, project, deployments: [] });
    });
  }

  it("still skips the list after a real subcommand", async () => {
    await deploymentsCommand.run!({ args: {}, rawArgs: ["get", FULL, "--json"] } as never);
    expect(stdout).toBe("");
  });
});

describe("creek status <id>", () => {
  it("resolves a deployment id of this directory's project and says so", async () => {
    serve(deployment({ status: "active" }, { url: "https://site-team.test" }));
    const code = await runExit(statusCommand.run!({ args: { id: SHORT } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      type: "deployment",
      deploymentId: FULL,
      status: "active",
      projectSource: "creek.toml",
    });
  });

  it("falls back to a sandbox when no deployment matches", async () => {
    server.use(
      http.get(`${API}/projects/site/deployments`, () => HttpResponse.json([])),
      http.get(`${SBX}/api/sandbox/sb123456/status`, () =>
        HttpResponse.json({ sandboxId: "sb123456", status: "active" }),
      ),
    );
    const code = await runExit(statusCommand.run!({ args: { id: "sb123456" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, type: "sandbox", sandboxId: "sb123456" });
  });

  it("is not_found naming both places when neither matches", async () => {
    server.use(
      http.get(`${API}/projects/site/deployments`, () => HttpResponse.json([])),
      http.get(`${SBX}/api/sandbox/nothing1/status`, () => new HttpResponse(null, { status: 404 })),
    );
    const code = await runExit(statusCommand.run!({ args: { id: "nothing1" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found" });
    expect(json().message).toMatch(/deployment of project "site".*sandbox/);
  });
});

describe("creek status (project)", () => {
  it("reports productionDeploymentId from the API's camelCase column", async () => {
    server.use(
      http.get(`${API}/projects/site`, () =>
        HttpResponse.json({
          id: "p1",
          slug: "site",
          framework: null,
          productionDeploymentId: FULL,
          createdAt: 1700000000000,
        }),
      ),
      http.get(`${API}/projects/site/bindings`, () => HttpResponse.json({ bindings: [] })),
    );
    const code = await runExit(statusCommand.run!({ args: {} } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      productionDeploymentId: FULL,
      createdAt: 1700000000000,
    });
    expect(json()).not.toHaveProperty("production_deployment_id");
    expect(commands()).toContain(`creek deployments get ${FULL} --project site --json`);
  });
});

describe("human follow-up commands carry --project like the JSON breadcrumbs", () => {
  // The cwd names "site"; these follow-ups are for "other".
  const lines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => String(c[0])).join("\n");

  it("printDeployment's Follow and Log lines", () => {
    const log = vi.spyOn(consola, "log").mockImplementation(() => {});
    printDeployment(toDeploymentView("other", FULL, deployment() as never));
    printDeployment(toDeploymentView("other", FULL, deployment({ status: "failed" }) as never));
    expect(lines(log)).toContain(`creek deployments wait ${FULL} --project other`);
    expect(lines(log)).toContain(`creek deployments logs ${FULL} --project other`);
    log.mockClear();
    // The cwd's own project stays bare.
    printDeployment(toDeploymentView("site", FULL, deployment() as never));
    expect(lines(log)).toContain(`creek deployments wait ${FULL}\n`);
  });

  it("a deploy timeout's human hints", () => {
    const info = vi.spyOn(consola, "info").mockImplementation(() => {});
    vi.spyOn(consola, "error").mockImplementation(() => {});
    try {
      reportWaitTimeout({ jsonMode: false, waitedMs: 1000, deploymentId: FULL, project: "other" });
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err;
    }
    expect(lines(info)).toContain(`creek deployments wait ${FULL} --project other`);
    expect(lines(info)).toContain(`creek deployments logs ${FULL} --project other`);
  });
});
