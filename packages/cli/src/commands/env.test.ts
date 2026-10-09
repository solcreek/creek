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
    out.breadcrumbs.some((b: { command: string }) => b.command.startsWith("creek deploy"))
  );
}

describe("creek env set", () => {
  it("dry-run does not POST and still reports pendingDeploy", async () => {
    let posted = false;
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(
      setCmd.run!({
        args: { key: "DATABASE_URL", value: "postgres://x", "dry-run": true },
      } as never),
    );
    expect(code).toBe(0);
    expect(posted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      key: "DATABASE_URL",
      pendingDeploy: true,
    });
    expect(json().nextStep).toBe("creek env set DATABASE_URL '$VALUE' --json");
    expect(json().sideEffects).toContain(
      "Replace $VALUE with the real secret; keep the single quotes",
    );
  });

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
  it("dry-run GETs the list and does not DELETE", async () => {
    let deleted = false;
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([{ key: "OLD_KEY", value: "secret" }]),
      ),
      http.delete(`${API}/projects/${SLUG}/env/OLD_KEY`, () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(rmCmd.run!({ args: { key: "OLD_KEY", "dry-run": true } } as never));
    expect(code).toBe(0);
    expect(deleted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      key: "OLD_KEY",
    });
  });

  it("dry-run wouldExecute is false when the key is missing", async () => {
    server.use(http.get(`${API}/projects/${SLUG}/env`, () => HttpResponse.json([])));
    const code = await runExit(rmCmd.run!({ args: { key: "MISSING", "dry-run": true } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ wouldExecute: false, exists: false });
  });

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

const lsCmd = (envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>)
  .ls;

describe("creek env --target", () => {
  it("sends --target to the server and reports it", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ok: true, key: "STRIPE_KEY", target: "production" },
          { status: 201 },
        );
      }),
    );
    const code = await runExit(
      setCmd.run!({ args: { key: "STRIPE_KEY", value: "sk_live", target: "production" } } as never),
    );
    expect(code).toBe(0);
    expect(body).toEqual({ key: "STRIPE_KEY", value: "sk_live", target: "production" });
    expect(json()).toMatchObject({ ok: true, key: "STRIPE_KEY", target: "production" });
    // Breadcrumbs name only commands that exist (env ls takes no --project).
    for (const b of json().breadcrumbs) expect(b.command).not.toContain("--project");
  });

  it("omits target for all, so servers without targets keep working", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, key: "A" }, { status: 201 });
      }),
    );
    expect(await runExit(setCmd.run!({ args: { key: "A", value: "v" } } as never))).toBe(0);
    expect(body).toEqual({ key: "A", value: "v" });
    expect(json()).toMatchObject({ ok: true, target: "all" });
  });

  it("refuses to report success when the server ignored the target", async () => {
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ ok: true, key: "STRIPE_KEY" }, { status: 201 }),
      ),
    );
    const code = await runExit(
      setCmd.run!({ args: { key: "STRIPE_KEY", value: "sk_live", target: "production" } } as never),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "target_unsupported", key: "STRIPE_KEY" });
    expect(json().message).toContain("creek env rm STRIPE_KEY");
  });

  it("rejects an unknown target before any request", async () => {
    for (const target of ["staging", "Production"]) {
      stdout = "";
      const code = await runExit(setCmd.run!({ args: { key: "A", value: "v", target } } as never));
      expect(code, target).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "invalid_target" });
    }
  });

  it("lists the target of each value", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([
          { key: "K", target: "all", value: "K***" },
          { key: "K", target: "production", value: "K***" },
          { key: "OLD", value: "OLD***" },
        ]),
      ),
    );
    expect(await runExit(lsCmd.run!({ args: {} } as never))).toBe(0);
    expect(json().vars.map((v: { key: string; target: string }) => [v.key, v.target])).toEqual([
      ["K", "all"],
      ["K", "production"],
      ["OLD", "all"],
    ]);
  });

  it("removes one target's value with --target, and says which values a dry run would remove", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([
          { key: "K", target: "all", value: "K***" },
          { key: "K", target: "preview", value: "K***" },
        ]),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { key: "K", "dry-run": true } } as never))).toBe(0);
    expect(json()).toMatchObject({ exists: true, targets: ["all", "preview"] });

    stdout = "";
    expect(
      await runExit(
        rmCmd.run!({ args: { key: "K", target: "production", "dry-run": true } } as never),
      ),
    ).toBe(0);
    expect(json()).toMatchObject({ exists: false, targets: [], wouldExecute: false });

    let url = "";
    server.use(
      http.delete(`${API}/projects/${SLUG}/env/K`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
    );
    stdout = "";
    expect(await runExit(rmCmd.run!({ args: { key: "K", target: "preview" } } as never))).toBe(0);
    expect(new URL(url).searchParams.get("target")).toBe("preview");
    expect(json()).toMatchObject({ ok: true, key: "K", target: "preview", removedValues: 1 });
  });
});
