import { CreekApiError, CreekAuthError } from "@solcreek/sdk";
import { fetchFailureReason, isNetworkFailure, mutationsMaybeApplied } from "./request-ledger.js";

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
  if (failure === "terminated") {
    return `The server's response broke off (${failed}) in a way a retry repeats. Report it; retrying will not help.`;
  }
  if (reason === "ENOTFOUND") {
    return `Could not reach the server (${failed}): the host was not found. Check the network connection, and CREEK_API_URL if you set one.`;
  }
  return `Could not reach the server (${failed}). Check the API URL (CREEK_API_URL) and certificates; retrying will not help.`;
}

/** The fields a network failure (server never reached, or lost mid-request) reports. */
export interface UnreachableFields {
  error: "api_unreachable";
  message: string;
  reason?: string;
  retryable: boolean;
  mayHaveApplied?: true;
}

/**
 * Classify a network failure, or null for any other error. Node's fetch
 * rejects with TypeError("fetch failed") when a server can't be reached, and
 * reading a body rejects with TypeError("terminated") when the connection
 * breaks mid-response. undici keeps the actual reason (ECONNREFUSED,
 * ENOTFOUND, a TLS error, UND_ERR_SOCKET) on `cause`: it tells a bad URL or
 * certificate from an outage.
 */
export function unreachableFields(err: unknown): UnreachableFields | null {
  if (!isNetworkFailure(err)) return null;
  const reason = fetchFailureReason(err);
  // Re-running is safe only if nothing this run did can have been applied:
  // the failing request included, which the ledger has already counted.
  const mayHaveApplied = mutationsMaybeApplied() > 0;
  // A body that broke off reached a server that answered, so never the URL
  // or a certificate. With no cause or a transient one the connection
  // dropped; other undici causes (a wrong content-length, a size limit)
  // come from the response itself and repeat on a retry.
  const brokeMidResponse = err.message === "terminated";
  const transient = reason !== undefined ? TRANSIENT_NETWORK_CODES.has(reason) : brokeMidResponse;
  const retryable = !mayHaveApplied && transient;
  return {
    error: "api_unreachable",
    message: unreachableMessage(err.message, reason, retryable, mayHaveApplied),
    ...(reason ? { reason } : {}),
    retryable,
    ...(mayHaveApplied ? { mayHaveApplied: true as const } : {}),
  };
}

/**
 * What a failed Creek API call adds to a command's `--json` error, so an
 * agent can act on it:
 *
 * - a refusal: the HTTP `status`, the API's own error code as `apiError`
 *   (`insufficient_scope`, `binding_conflict`, …) and its other fields as
 *   `details` (`required` / `granted`, `conflicts`, `newBindings`). The
 *   command's own `error` code stays.
 * - a network failure: `error: "api_unreachable"`, a `message` that says
 *   whether to retry, `reason`, `retryable` and, when a write of this run may
 *   have been applied, `mayHaveApplied: true` — the same fields the CLI
 *   runner reports for a failure no command handled.
 *
 * Empty for any other error. Spread it LAST into every error a command
 * reports — `{ ok: false, error: "set_failed", message, ...apiErrorFields(err) }`
 * — so a network failure's `error` and `message` win over the command's.
 */
export function apiErrorFields(err: unknown): {
  status?: number;
  apiError?: string;
  details?: Record<string, unknown>;
} & Partial<UnreachableFields> {
  const unreachable = unreachableFields(err);
  if (unreachable) return unreachable;
  if (err instanceof CreekAuthError) return { status: 401, apiError: "unauthorized" };
  if (!(err instanceof CreekApiError)) return {};
  return {
    status: err.status,
    apiError: err.code,
    ...(Object.keys(err.details ?? {}).length > 0 ? { details: err.details } : {}),
  };
}

/**
 * Lines a person needs beyond the error's message: what to do about a network
 * failure, and the API error codes that have a hint. Empty for the rest.
 */
export function apiErrorHints(err: unknown): string[] {
  const unreachable = unreachableFields(err);
  if (unreachable) return [unreachable.message];
  if (err instanceof CreekAuthError) {
    return ["The API key was not accepted. Run `creek login` with a valid key."];
  }
  if (!(err instanceof CreekApiError)) return [];
  const list = (value: unknown) =>
    Array.isArray(value) && value.length > 0 ? value.join(", ") : "none";
  switch (err.code) {
    case "insufficient_scope":
      return [
        `Required scope: ${list(err.details.required)}. This key has: ${list(err.details.granted)}.`,
        "Use a key that holds the scope.",
      ];
    case "insufficient_role":
      return ["The key holds the scope, but its owner's team role no longer allows it."];
    case "binding_conflict":
      return Array.isArray(err.details.conflicts) && err.details.conflicts.length > 1
        ? err.details.conflicts.map((c) => `- ${String(c)}`)
        : [];
    default:
      return [];
  }
}
