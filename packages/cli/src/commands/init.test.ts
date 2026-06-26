import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "./init.js";

// init is non-interactive in tests (no TTY) — jsonMode auto-enables and
// prompts are skipped, which is exactly the agent/CI environment the
// --db flag exists for.

function runInit(args: Record<string, unknown>): Promise<unknown> {
  // citty's run() receives parsed args; "_" mirrors positional args.
  return (initCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
    args: { _: [], ...args },
  });
}

describe("creek init --db (non-interactive)", () => {
  let dir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-init-test-"));
    prevCwd = process.cwd();
    process.chdir(dir);
    // jsonOutput writes JSON to stdout then calls process.exit — stub
    // both so the run() continues and we can inspect the payload.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("--db writes [build].worker + [resources].database and scaffolds worker/index.ts", async () => {
    await runInit({ name: "demo", db: true, yes: true });

    const toml = readFileSync(join(dir, "creek.toml"), "utf-8");
    expect(toml).toContain('name = "demo"');
    expect(toml).toContain('worker = "worker/index.ts"');
    expect(toml).toMatch(/\[resources\][\s\S]*database = true/);
    expect(existsSync(join(dir, "worker", "index.ts"))).toBe(true);
  });

  it("--db surfaces the dependency-install step as a breadcrumb before deploy", async () => {
    await runInit({ name: "demo", db: true, yes: true });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    // The scaffolded worker imports hono/creek/d1-schema which init does
    // not install — the next deploy fails without them. The agent/CI path
    // must learn this, and the install step must precede `creek deploy`.
    expect(payload.workerDependencies).toEqual(["hono", "creek", "d1-schema"]);
    const commands = payload.breadcrumbs.map((b: { command: string }) => b.command);
    const installIdx = commands.findIndex((c: string) => c.startsWith("npm install"));
    const deployIdx = commands.indexOf("creek deploy");
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(commands[installIdx]).toContain("hono creek d1-schema");
    expect(installIdx).toBeLessThan(deployIdx);
  });

  it("without --db emits no worker-dependency install breadcrumb", async () => {
    await runInit({ name: "demo", yes: true });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.workerDependencies).toBeUndefined();
    const commands = payload.breadcrumbs.map((b: { command: string }) => b.command);
    expect(commands.some((c: string) => c.startsWith("npm install"))).toBe(false);
  });

  it("without --db, skips the prompt and surfaces a --db breadcrumb", async () => {
    await runInit({ name: "demo", yes: true });

    const toml = readFileSync(join(dir, "creek.toml"), "utf-8");
    expect(toml).not.toContain("worker =");
    expect(toml).not.toContain("[resources]");
    expect(existsSync(join(dir, "worker"))).toBe(false);

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.database).toBe(false);
    expect(payload.databasePromptSkipped).toBe(true);
    expect(JSON.stringify(payload.breadcrumbs)).toContain("creek init --db");
  });

  it("flags a Node HTTP-server stack (Express) as a compatibility warning up front", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { express: "^4.19.0" } }),
    );
    await runInit({ name: "demo", yes: true });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(Array.isArray(payload.compatibilityWarnings)).toBe(true);
    const codes = payload.compatibilityWarnings.map((f: { code: string }) => f.code);
    expect(codes).toContain("CK-NODE-HTTP-SERVER");
    // And points the user at the full diagnostic.
    const cmds = payload.breadcrumbs.map((b: { command: string }) => b.command);
    expect(cmds).toContain("creek doctor");
  });

  it("emits no compatibility warnings for a Workers-compatible (Hono) stack", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { hono: "^4.6.0" } }),
    );
    await runInit({ name: "demo", yes: true });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.compatibilityWarnings).toBeUndefined();
    const cmds = payload.breadcrumbs.map((b: { command: string }) => b.command);
    expect(cmds).not.toContain("creek doctor");
  });

  it("discloses the .gitignore mutation in the --json payload", async () => {
    await runInit({ name: "demo", yes: true });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    // init silently appended Creek + AI-agent entries before this fix.
    // The agent/CI path must learn that .gitignore was touched.
    expect(Array.isArray(payload.gitignoreAdded)).toBe(true);
    expect(payload.gitignoreAdded).toContain(".creek");
    expect(payload.gitignoreAdded).toContain(".claude");
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
  });
});
