/**
 * Shared output utilities for agent-friendly CLI.
 *
 * --json flag + non-TTY auto-detection ensures every command
 * can produce structured output for agents, CI/CD, and pipes.
 */

import type { StdioOptions } from "node:child_process";

export const isTTY = process.stdout.isTTY ?? false;

let stdoutGuarded = false;
// True only while jsonOutput() is writing the result: the one moment the guard
// lets a write through to stdout.
let writingJson = false;

/**
 * Reserve stdout for the command's single JSON result.
 *
 * In JSON mode an agent, CI job or pipe parses stdout as one JSON document,
 * so nothing else may reach it: not consola's progress lines (consola writes
 * info/log/success to stdout when stdout isn't a TTY), not notices such as the
 * Terms of Service line, not an interactive prompt. After this call every
 * write to process.stdout goes to stderr instead, where it stays visible;
 * jsonOutput() still writes the result to stdout. Idempotent.
 *
 * Child processes write to file descriptor 1 directly and bypass this; give
 * them childStdio() so their stdout lands on stderr too.
 *
 * Only for commands whose JSON output is one document. `creek logs` streams
 * NDJSON on stdout and must not call this.
 */
export function guardJsonStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  const toStdout = process.stdout.write.bind(process.stdout);
  const toStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) =>
    writingJson
      ? toStdout(...args)
      : (toStderr as typeof toStdout)(...args)) as typeof process.stdout.write;
}

/** Whether guardJsonStdout() is in effect. */
export function isJsonStdoutGuarded(): boolean {
  return stdoutGuarded;
}

/**
 * stdio for a child process (a build, a release command, `next build`).
 * Normally it inherits the terminal. While stdout is reserved for JSON, the
 * child's stdout is attached to this process's stderr: it still streams live,
 * and it never mixes into the JSON. Unlike "pipe", nothing is buffered, so a
 * build that prints a lot can't overflow execSync's buffer.
 */
export function childStdio(): StdioOptions {
  return stdoutGuarded ? ["inherit", 2, "inherit"] : "inherit";
}

/** A suggested next command for agents to follow. */
export interface Breadcrumb {
  command: string;
  description: string;
}

/**
 * The envelope every `--json` result carries: `ok: boolean`, and on failure
 * also `error` (a machine code) and `message` (for a person). A result that
 * leaves `ok` out gets it from the exit code; a failure without `error` or
 * `message` gets a generic one, so an agent can always branch on `ok` and
 * report `error` / `message`. Commands should still set all three
 * themselves: this is the floor, not the contract's source.
 */
export function withEnvelope(data: Record<string, unknown>, exitCode: number) {
  const ok = typeof data.ok === "boolean" ? data.ok : exitCode === 0;
  // `ok` first, where an agent reading the output looks.
  const out: Record<string, unknown> = { ok, ...data };
  out.ok = ok;
  if (ok) return out;
  const error = typeof data.error === "string" && data.error ? data.error : "command_failed";
  out.error = error;
  if (typeof data.message !== "string" || !data.message) out.message = error;
  return out;
}

/**
 * Output structured JSON and exit. The one way a command prints a `--json`
 * result: {@link withEnvelope} guarantees `ok` (and `error` / `message` on a
 * failure), and a test fails on a command that prints JSON any other way.
 */
export function jsonOutput(
  data: Record<string, unknown>,
  exitCode = 0,
  breadcrumbs?: Breadcrumb[],
): never {
  const enveloped = withEnvelope(data, exitCode);
  const output = breadcrumbs?.length ? { ...enveloped, breadcrumbs } : enveloped;
  writingJson = true;
  try {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } finally {
    writingJson = false;
  }
  process.exit(exitCode);
}

/**
 * Write one NDJSON line to stdout and keep running: the streaming
 * counterpart of {@link jsonOutput}, for output an agent reads line by line
 * (`creek logs --json`, `creek deployments logs --raw`). Each record is one
 * compact JSON object.
 */
export function jsonLine(record: Record<string, unknown>): void {
  writingJson = true;
  try {
    process.stdout.write(JSON.stringify(record) + "\n");
  } finally {
    writingJson = false;
  }
}

/** Resolve JSON mode: explicit --json flag OR non-TTY environment. */
export function resolveJsonMode(args: { json?: boolean }): boolean {
  return args.json === true || !isTTY;
}

/**
 * Common --json and --yes args to spread into any command's args definition.
 *
 * Usage:
 *   args: { ...globalArgs, myArg: { ... } }
 */
export const globalArgs = {
  json: {
    type: "boolean" as const,
    description: "Output results as JSON (auto-enabled in CI/CD and pipes)",
    default: false,
  },
  yes: {
    type: "boolean" as const,
    alias: "y",
    description: "Skip confirmation prompts (auto-enabled in non-TTY)",
    default: false,
  },
};

/** Should we skip interactive prompts? */
export function shouldAutoConfirm(args: { yes?: boolean }): boolean {
  return args.yes === true || !isTTY;
}

/** Output an error in the appropriate format and exit. */
export function exitError(
  jsonMode: boolean,
  error: string,
  message: string,
  exitCode = 1,
  breadcrumbs?: Breadcrumb[],
): never {
  if (jsonMode) jsonOutput({ ok: false, error, message }, exitCode, breadcrumbs);
  return process.exit(exitCode);
}

/** Reusable breadcrumbs for common error states. */
export const AUTH_BREADCRUMBS: Breadcrumb[] = [
  {
    command: "creek login --token <KEY> --json",
    description: "Authenticate with an API key (agents/CI)",
  },
  { command: "creek login", description: "Authenticate in a terminal (opens a browser)" },
];

/** Non-TTY / agent deploy to a 60-minute sandbox. Copy-pasteable. */
export const AGENT_SANDBOX_DEPLOY = "creek deploy --sandbox --json";
/** Non-TTY / agent deploy to production. Copy-pasteable. Requires sign-in. */
export const AGENT_PROD_DEPLOY = "creek deploy --prod --json";

export const NO_PROJECT_BREADCRUMBS: Breadcrumb[] = [
  { command: "creek init", description: "Initialize creek.toml in current directory" },
  {
    command: "creek deploy --sandbox --json",
    description: "Deploy a 60-minute preview (add index.html or a package.json first)",
  },
];
