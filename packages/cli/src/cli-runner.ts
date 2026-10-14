import { runCommand, runMain } from "citty";
import consola from "consola";
import { jsonOutput, type Breadcrumb } from "./utils/output.js";
import { buildHelpSchema, findUnknownFlags, unknownFlagMessage } from "./help-schema.js";
import { apiErrorFields } from "./utils/api-error.js";
import {
  fetchFailureReason,
  isNetworkFailure,
  mutationsMaybeApplied,
} from "./utils/request-ledger.js";

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

/**
 * Network failures that can pass on their own: a refused or reset
 * connection, a timeout, a network or route that is down, a temporary DNS
 * failure. Whether re-running the command is safe is a separate question,
 * answered by the request ledger: it is, only when no mutating request of
 * this run may have been applied.
 *
 * Not here, and so never retryable: ENOTFOUND (a wrong host, or on macOS and
 * Windows no network at all), a TLS or certificate error, `bad port`,
 * `unknown scheme` — configuration that fails the same way again.
 */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/** What to tell the caller about an unreachable server. */
function unreachableMessage(
  failure: string,
  reason: string | undefined,
  retryable: boolean,
  mayHaveApplied: boolean,
): string {
  const failed = `${failure}${reason ? `: ${reason}` : ""}`;
  if (retryable) {
    const what =
      failure === "terminated"
        ? "The connection broke while reading the server's response"
        : "Could not reach the server";
    return `${what} (${failed}). Nothing this command changes was applied: retry.`;
  }
  if (mayHaveApplied) {
    return `Lost the server (${failed}) after this command may have changed something. Check the result (e.g. creek status, creek deployments) before running it again.`;
  }
  if (reason === "ENOTFOUND") {
    return `Could not reach the server (${failed}): the host was not found. Check the network connection, and CREEK_API_URL if you set one.`;
  }
  return `Could not reach the server (${failed}). Check the API URL (CREEK_API_URL) and certificates; retrying will not help.`;
}

const HELP_BREADCRUMBS: Breadcrumb[] = [
  { command: "creek --help --json", description: "Machine-readable command schema" },
];

/**
 * Entry runner. In human mode (TTY, no --json) it defers entirely to
 * citty's runMain so behaviour is unchanged. In JSON mode it runs the
 * command itself and converts citty's CLIErrors into structured JSON on
 * stdout with a non-zero exit. --help / --version always go through
 * runMain so human output is preserved. JSON mode intercepts --help/-h
 * and emits the command schema instead of citty's usage text.
 */
export async function runCli(
  main: CittyCommand,
  rawArgs: string[],
  opts: { jsonMode: boolean },
): Promise<void> {
  const isHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
  const isVersionOnly = rawArgs.length === 1 && rawArgs[0] === "--version";

  if (isHelp && opts.jsonMode) {
    const schema = buildHelpSchema(main, rawArgs);
    jsonOutput(
      schema as Record<string, unknown>,
      schema.ok ? 0 : 1,
      schema.ok ? undefined : HELP_BREADCRUMBS,
    );
  }

  if (isHelp || isVersionOnly) {
    await runMain(main, { rawArgs });
    return;
  }

  const unknownFlags = findUnknownFlags(main, rawArgs);
  if (unknownFlags.length > 0) {
    const schema = buildHelpSchema(main, rawArgs);
    const path = schema.ok ? schema.path : [];
    const message = unknownFlagMessage(unknownFlags, path);
    if (opts.jsonMode) {
      jsonOutput({ ok: false, error: "unknown_flag", message, flags: unknownFlags }, 1, [
        {
          command: `${["creek", ...path].join(" ") || "creek"} --help --json`,
          description: "List flags this command actually accepts",
        },
      ]);
    }
    consola.error(message);
    process.exit(1);
  }

  if (!opts.jsonMode) {
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
    // A runtime error no command handled. In JSON mode the caller still needs
    // a JSON result on stdout (an empty stdout doesn't parse), and nothing
    // else may reach stdout. A CLI bug goes to stderr with its stack, for
    // whoever reads the logs. A refused API call is not a bug: it keeps the
    // API's own error code (`binding_conflict`, `insufficient_scope`, …),
    // its fields carry what a hint would say, and stderr gets the message
    // only.
    const api = apiErrorFields(err);
    // Node's fetch rejects with TypeError("fetch failed") when a server can't
    // be reached, and reading a body rejects with TypeError("terminated")
    // when the connection breaks mid-response: network, not a CLI bug.
    // undici keeps the actual reason (ECONNREFUSED, ENOTFOUND, a TLS error,
    // UND_ERR_SOCKET) on `cause`: it tells a bad URL or certificate from an
    // outage.
    const unreachable = isNetworkFailure(err);
    const reason = fetchFailureReason(err);
    if (api.apiError || unreachable) {
      const text = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${reason ? `${text}: ${reason}` : text}\n`);
    } else {
      consola.error(err);
    }
    // Re-running is safe only if nothing this run did can have been applied:
    // the failing request included, which the ledger has already counted.
    const mayHaveApplied = unreachable && mutationsMaybeApplied() > 0;
    const retryable =
      unreachable && !mayHaveApplied && reason !== undefined && TRANSIENT_NETWORK_CODES.has(reason);
    jsonOutput(
      {
        ok: false,
        error: api.apiError ?? (unreachable ? "api_unreachable" : "internal_error"),
        message: unreachable
          ? unreachableMessage((err as TypeError).message, reason, retryable, mayHaveApplied)
          : err instanceof Error
            ? err.message
            : String(err),
        ...(reason ? { reason } : {}),
        ...(unreachable ? { retryable } : {}),
        ...(mayHaveApplied ? { mayHaveApplied: true } : {}),
        ...api,
      },
      1,
    );
  }
}
