import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { envCommand } from "./env.js";

// Drive `creek env set/rm` against MSW. Tests run non-TTY, so resolveJsonMode
// is true and the commands emit JSON (with breadcrumbs) before exiting — that
// JSON path is what an AI agent reads, so we assert the redeploy guidance is
// present there. The human-readable `consola.info` hint runs only under a real
// TTY and isn't exercised here. Fabricated IDs only.
const API = "https://cp.test";
const SLUG = "myproj";

const setCmd = (
  envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>
).set;
const rmCmd = (envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>)
  .rm;

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

  // getProjectSlug() reads creek.toml from the current working directory.
  testDir = join(tmpdir(), `creek-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
function hasDeployBreadcrumb(): boolean {
  const out = json();
  return (
    Array.isArray(out.breadcrumbs) &&
    out.breadcrumbs.some((b: { command: string }) => b.command === "creek deploy")
  );
}

describe("creek env set", () => {
  it("sets the variable and tells the user a deploy is needed to apply it", async () => {
    let body: { key: string; value: string } | null = null;
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, async ({ request }) => {
        body = (await request.json()) as { key: string; value: string };
        return HttpResponse.json({ ok: true, key: body.key });
      }),
    );

    const code = await runExit(
      setCmd.run!({ args: { key: "DATABASE_URL", value: "postgres://x" } } as never),
    );

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, key: "DATABASE_URL", project: SLUG });
    expect(body).toEqual({ key: "DATABASE_URL", value: "postgres://x" });
    // The redeploy guidance must be present so a set doesn't look like it took
    // effect immediately.
    expect(hasDeployBreadcrumb()).toBe(true);
  });
});

describe("creek env rm", () => {
  it("removes the variable and surfaces the redeploy guidance", async () => {
    server.use(
      http.delete(`${API}/projects/${SLUG}/env/OLD_KEY`, () => HttpResponse.json({ ok: true })),
    );

    const code = await runExit(rmCmd.run!({ args: { key: "OLD_KEY" } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, key: "OLD_KEY", removed: true });
    expect(hasDeployBreadcrumb()).toBe(true);
  });
});
