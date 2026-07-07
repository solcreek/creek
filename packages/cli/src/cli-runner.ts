import { runCommand, runMain } from "citty";
import { jsonOutput, type Breadcrumb } from "./utils/output.js";

type CittyCommand = Parameters<typeof runMain>[0];

/**
 * citty throws a `CLIError` (not exported, so we match on shape) when the
 * user gives an unknown subcommand, no subcommand, or a missing required
 * argument. Its default handler prints human usage to stdout and a
 * separate error line to stderr — which means an agent or script parsing
 * `--json` stdout gets usage text and a JSON.parse failure.
 *
 * Map those errors to a structured payload so the JSON/agent path always
 * gets machine-readable output. Returns null for anything that isn't a
 * citty CLIError (real runtime errors propagate unchanged).
 */
const CITTY_ERROR_CODES: Record<string, string> = {
  E_UNKNOWN_COMMAND: "unknown_command",
  E_NO_COMMAND: "no_command",
  EARG: "missing_argument",
  E_NO_VERSION: "no_version",
};

export function cliErrorToJson(err: unknown): { ok: false; error: string; message: string } | null {
  const e = err as { name?: string; code?: string; message?: string };
  if (!e || e.name !== "CLIError") return null;
  const error = CITTY_ERROR_CODES[e.code ?? ""] ?? "cli_error";
  return { ok: false, error, message: e.message ?? "CLI error" };
}

/**
 * Whether the invocation wants JSON output. Mirrors resolveJsonMode:
 * explicit --json, or a non-TTY stdout (agents/CI/pipes).
 */
export function wantsJson(rawArgs: string[], isTTY: boolean): boolean {
  return rawArgs.includes("--json") || !isTTY;
}

const HELP_BREADCRUMBS: Breadcrumb[] = [
  { command: "creek --help", description: "List available commands" },
];

/**
 * Entry runner. In human mode (TTY, no --json) it defers entirely to
 * citty's runMain so behaviour is unchanged. In JSON mode it runs the
 * command itself and converts citty's CLIErrors into structured JSON on
 * stdout with a non-zero exit. --help / --version always go through
 * runMain so their output is preserved.
 */
export async function runCli(
  main: CittyCommand,
  rawArgs: string[],
  opts: { jsonMode: boolean },
): Promise<void> {
  const isHelpOrVersion =
    rawArgs.includes("--help") ||
    rawArgs.includes("-h") ||
    (rawArgs.length === 1 && rawArgs[0] === "--version");

  if (isHelpOrVersion || !opts.jsonMode) {
    await runMain(main, { rawArgs });
    return;
  }

  try {
    await runCommand(main, { rawArgs });
  } catch (err) {
    const structured = cliErrorToJson(err);
    if (structured) {
      // jsonOutput writes to stdout and exits non-zero.
      jsonOutput(structured, 1, HELP_BREADCRUMBS);
    }
    throw err; // real runtime error — let the caller surface it
  }
}
