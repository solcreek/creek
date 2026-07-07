import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineCommand } from "citty";
import { cliErrorToJson, wantsJson, runCli } from "./cli-runner.js";

describe("cliErrorToJson", () => {
  it("maps citty CLIError codes to structured errors", () => {
    expect(
      cliErrorToJson({
        name: "CLIError",
        code: "E_UNKNOWN_COMMAND",
        message: "Unknown command `unset`",
      }),
    ).toEqual({ ok: false, error: "unknown_command", message: "Unknown command `unset`" });
    expect(
      cliErrorToJson({ name: "CLIError", code: "E_NO_COMMAND", message: "No command specified." }),
    ).toMatchObject({ error: "no_command" });
    expect(
      cliErrorToJson({
        name: "CLIError",
        code: "EARG",
        message: "Missing required positional argument: NAME",
      }),
    ).toMatchObject({ error: "missing_argument" });
  });

  it("falls back to cli_error for an unknown CLIError code", () => {
    expect(cliErrorToJson({ name: "CLIError", code: "E_WHATEVER", message: "x" })).toMatchObject({
      error: "cli_error",
    });
  });

  it("returns null for non-CLIError values", () => {
    expect(cliErrorToJson(new Error("boom"))).toBeNull();
    expect(cliErrorToJson({ name: "TypeError" })).toBeNull();
    expect(cliErrorToJson(null)).toBeNull();
  });
});

describe("wantsJson", () => {
  it("is true with --json or when stdout is not a TTY", () => {
    expect(wantsJson(["--json"], true)).toBe(true);
    expect(wantsJson([], false)).toBe(true);
    expect(wantsJson(["deploy", "--json"], true)).toBe(true);
  });
  it("is false in a plain TTY invocation", () => {
    expect(wantsJson(["deploy"], true)).toBe(false);
  });
});

describe("runCli (JSON mode error conversion)", () => {
  class ExitSignal extends Error {
    constructor(public code: number) {
      super(`exit:${code}`);
    }
  }
  let stdout: string;
  beforeEach(() => {
    stdout = "";
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  // A tiny app mirroring the real CLI shape: a parent with subcommands and
  // a child that takes a required positional.
  const child = defineCommand({
    meta: { name: "child" },
    args: { name: { type: "positional", required: true } },
    run() {
      /* never reached in these tests */
    },
  });
  const app = defineCommand({
    meta: { name: "app" },
    subCommands: { child },
  });

  async function runExit(p: Promise<unknown>): Promise<number> {
    try {
      await p;
      throw new Error("expected process.exit");
    } catch (err) {
      if (err instanceof ExitSignal) return err.code;
      throw err;
    }
  }

  it("converts an unknown subcommand to structured JSON, exit 1", async () => {
    const code = await runExit(runCli(app, ["bogus"], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "unknown_command" });
  });

  it("converts a missing required positional (EARG) to structured JSON", async () => {
    const code = await runExit(runCli(app, ["child"], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "missing_argument" });
  });

  it("converts no-command to structured JSON", async () => {
    const code = await runExit(runCli(app, [], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "no_command" });
  });

  it("stdout is pure JSON (parseable, no usage text)", async () => {
    await runExit(runCli(app, ["bogus"], { jsonMode: true }));
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
