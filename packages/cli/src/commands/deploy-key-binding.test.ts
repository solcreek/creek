import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A saved key bound (by `creek login`) to another API than the one the CLI
// would talk to. getToken() refuses to send it (api_mismatch). A deploy
// that never sends it — a sandbox, a dry-run plan — must not be stopped by
// that; a production deploy, which would send it, must be.

vi.mock("../utils/tos.js", () => ({
  ensureTosAccepted: vi.fn(async () => ({ version: "test", acceptedAt: "test" })),
}));

import { deployCommand, deployHandlers } from "./deploy.js";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let home: string;
let work: string;
let prevHome: string | undefined;
let prevCwd: string;
let stdout: string;
let handlers: Record<string, ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevCwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), "creek-bind-home-"));
  work = mkdtempSync(join(tmpdir(), "creek-bind-work-"));
  process.env.HOME = home;
  delete process.env.CREEK_TOKEN;
  // The CLI talks to this API; the saved key belongs to another.
  process.env.CREEK_API_URL = "https://cp.test";
  mkdirSync(join(home, ".creek"));
  writeFileSync(
    join(home, ".creek", "config.json"),
    JSON.stringify({ token: "crk_sk_live_AbCdEfGh", tokenApiUrl: "https://api.creek.dev" }),
  );
  writeFileSync(join(work, "index.html"), "<h1>hi</h1>");
  process.chdir(work);

  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  handlers = {};
  for (const name of Object.keys(deployHandlers) as (keyof typeof deployHandlers)[]) {
    handlers[name] = vi
      .spyOn(deployHandlers, name)
      .mockImplementation((async () => undefined) as never);
  }
});

afterEach(() => {
  process.chdir(prevCwd);
  process.env.HOME = prevHome;
  delete process.env.CREEK_API_URL;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Run `creek deploy` with args; the exit code, or null when it returned. */
async function deploy(args: Record<string, unknown>): Promise<number | null> {
  try {
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { json: true, ...args },
    });
    return null;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}
const json = () => JSON.parse(stdout.slice(stdout.indexOf("{")));

describe("creek deploy with a saved key bound to another API", () => {
  it("--sandbox deploys (the key is never sent)", async () => {
    await deploy({ sandbox: true });
    expect(stdout).not.toContain("api_mismatch");
    expect(handlers.deploySandbox).toHaveBeenCalledOnce();
  });

  it("--dry-run plans (no request, no key)", async () => {
    expect(await deploy({ "dry-run": true, prod: true })).toBe(0);
    expect(json()).toMatchObject({ ok: true, mode: "dry-run" });
  });

  it("--prod refuses with api_mismatch before deploying", async () => {
    expect(await deploy({ prod: true })).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "api_mismatch" });
    expect(handlers.deployAuthenticated).not.toHaveBeenCalled();
    expect(handlers.deploySandbox).not.toHaveBeenCalled();
  });
});
