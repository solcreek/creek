import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineCommand } from "citty";
import consola from "consola";
import { CreekApiError, CreekAuthError } from "@solcreek/sdk";
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

  it("turns an unhandled runtime error into a JSON internal_error, exit 1", async () => {
    // Without this, stdout is empty and a JSON parser gets nothing at all.
    const boom = defineCommand({
      meta: { name: "boom" },
      run() {
        throw new TypeError("Cannot read properties of undefined (reading 'filter')");
      },
    });
    const error = vi.spyOn(consola, "error").mockImplementation(() => {});
    const code = await runExit(runCli(boom, [], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "internal_error",
      message: "Cannot read properties of undefined (reading 'filter')",
    });
    expect(error).toHaveBeenCalled(); // the error itself still reaches stderr
  });

  it("reports an unhandled API error under the API's own code, not internal_error", async () => {
    // e.g. a deploy whose bundle upload the control plane refuses.
    const refused = defineCommand({
      meta: { name: "refused" },
      run() {
        throw new CreekApiError(
          409,
          "binding_conflict",
          "DB is both a binding and a project environment variable.",
          {
            conflicts: ["DB is both a binding and a project environment variable."],
          },
        );
      },
    });
    const error = vi.spyOn(consola, "error").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runExit(runCli(refused, [], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "binding_conflict",
      message: "DB is both a binding and a project environment variable.",
      status: 409,
      apiError: "binding_conflict",
      details: { conflicts: ["DB is both a binding and a project environment variable."] },
    });
    // stdout is the JSON alone (asserted by JSON.parse above, with consola's
    // info writer unmocked); an API refusal is not a CLI crash: stderr gets
    // the message, no stack trace.
    expect(error).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toBe(
      "DB is both a binding and a project environment variable.\n",
    );
  });

  it("reports an unreachable server as api_unreachable, not internal_error", async () => {
    const offline = defineCommand({
      meta: { name: "offline" },
      run() {
        // undici's shape: a fixed message, the reason on `cause`.
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
            code: "ECONNREFUSED",
          }),
        });
      },
    });
    const error = vi.spyOn(consola, "error").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runExit(runCli(offline, [], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "api_unreachable",
      message: "Could not reach the server (fetch failed: ECONNREFUSED). Retry.",
      reason: "ECONNREFUSED",
      retryable: true,
    });
    expect(error).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toBe(
      "fetch failed: ECONNREFUSED\n",
    );
  });

  // Causes as Node 24's fetch reports them (measured 2026-10-13): code when
  // the socket layer has one, else only a message.
  it.each([
    ["a refused connection", { code: "ECONNREFUSED" }, "ECONNREFUSED", true],
    ["a connect timeout", { code: "UND_ERR_CONNECT_TIMEOUT" }, "UND_ERR_CONNECT_TIMEOUT", true],
    ["a temporary DNS failure", { code: "EAI_AGAIN" }, "EAI_AGAIN", true],
    ["an unknown host", { code: "ENOTFOUND" }, "ENOTFOUND", false],
    [
      "a self-signed proxy certificate",
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
      "SELF_SIGNED_CERT_IN_CHAIN",
      false,
    ],
    ["a blocked port", { message: "bad port" }, "bad port", false],
    ["a non-HTTP(S) API URL", { message: "unknown scheme" }, "unknown scheme", false],
  ])(
    "marks %s retryable=%s only when it can pass on its own",
    async (_label, cause, reason, retryable) => {
      const offline = defineCommand({
        meta: { name: "offline" },
        run() {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error(cause.message ?? "x"), cause),
          });
        },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await runExit(runCli(offline, [], { jsonMode: true }));
      const out = JSON.parse(stdout);
      expect(out).toMatchObject({ error: "api_unreachable", reason, retryable });
      expect(out.message).toContain(retryable ? "Retry." : "retrying will not help");
    },
  );

  it("is not retryable when the cause gives no reason", async () => {
    const offline = defineCommand({
      meta: { name: "offline" },
      run() {
        throw new TypeError("fetch failed");
      },
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runExit(runCli(offline, [], { jsonMode: true }));
    expect(JSON.parse(stdout)).toMatchObject({ error: "api_unreachable", retryable: false });
    expect(JSON.parse(stdout)).not.toHaveProperty("reason");
  });

  it("reports a rejected API key as unauthorized", async () => {
    const rejected = defineCommand({
      meta: { name: "rejected" },
      run() {
        throw new CreekAuthError("Invalid API key");
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runExit(runCli(rejected, [], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "unauthorized",
      message: "Invalid API key",
      status: 401,
      apiError: "unauthorized",
    });
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toBe("Invalid API key\n");
  });

  it("stdout is pure JSON (parseable, no usage text)", async () => {
    await runExit(runCli(app, ["bogus"], { jsonMode: true }));
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("emits a command schema for --help --json instead of citty usage text", async () => {
    const code = await runExit(runCli(app, ["--help", "--json"], { jsonMode: true }));
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.path).toEqual([]);
    expect(payload.command.name).toBe("app");
    expect(payload.command.subcommands.map((c: { name: string }) => c.name)).toEqual(["child"]);
  });

  it("emits nested schema for child --help --json", async () => {
    const code = await runExit(runCli(app, ["child", "--help", "--json"], { jsonMode: true }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      path: ["child"],
      command: { name: "child" },
    });
  });

  it("refuses --dry-run on a command that does not declare it", async () => {
    const code = await runExit(runCli(app, ["child", "x", "--dry-run"], { jsonMode: true }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: "unknown_flag",
      flags: ["--dry-run"],
    });
  });
});
