import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
    expect(toml).toContain('worker = "worker/index.ts"');
    expect(toml).toMatch(/\[resources\][\s\S]*database = true/);
    expect(existsSync(join(dir, "worker", "index.ts"))).toBe(true);
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
});
