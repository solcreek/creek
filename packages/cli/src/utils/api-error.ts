import { CreekApiError, CreekAuthError } from "@solcreek/sdk";

/**
 * What a failed Creek API call adds to a command's `--json` error, so an
 * agent can act on it: the HTTP `status`, the API's own error code as
 * `apiError` (`insufficient_scope`, `binding_conflict`, …) and its other
 * fields as `details` (`required` / `granted`, `conflicts`, `newBindings`).
 *
 * Empty for any other error, so a command can spread it into every error
 * it reports.
 */
export function apiErrorFields(err: unknown): {
  status?: number;
  apiError?: string;
  details?: Record<string, unknown>;
} {
  if (err instanceof CreekAuthError) return { status: 401, apiError: "unauthorized" };
  if (!(err instanceof CreekApiError)) return {};
  return {
    status: err.status,
    apiError: err.code,
    ...(Object.keys(err.details ?? {}).length > 0 ? { details: err.details } : {}),
  };
}

/**
 * Lines a person needs beyond the API's message, for the error codes that
 * have one. Empty for the rest.
 */
export function apiErrorHints(err: unknown): string[] {
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
