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

describe("creek rollback --dry-run", () => {
  it("does not POST rollback and names the previous deployment", async () => {
    let posted = false;
    server.use(
      http.get(`${API}/projects/${SLUG}/deployments`, () =>
        HttpResponse.json([
          {
            id: "dep-new",
            projectId: "p1",
            version: 2,
            status: "active",
            branch: "main",
            commitSha: null,
            commitMessage: null,
            triggerType: "cli",
            failedStep: null,
            errorMessage: null,
            createdAt: 200,
            updatedAt: 200,
          },
          {
            id: "dep-old",
            projectId: "p1",
            version: 1,
            status: "active",
            branch: "main",
            commitSha: null,
            commitMessage: null,
            triggerType: "cli",
            failedStep: null,
            errorMessage: null,
            createdAt: 100,
            updatedAt: 100,
          },
        ]),
      ),
      http.post(`${API}/projects/${SLUG}/rollback`, () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const code = await runExit(
      (rollbackCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
        args: { "dry-run": true, json: true },
      }),
    );
    expect(code).toBe(0);
    expect(posted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      currentDeploymentId: "dep-new",
      targetDeploymentId: "dep-old",
    });
    expect(json().nextStep).toBe("creek rollback dep-old --json");
  });
});
