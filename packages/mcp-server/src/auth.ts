/**
 * Resolve a Creek API key from the MCP HTTP request.
 *
 * Authenticated tools must not take `apiKey` as a tool argument — that
 * puts the secret in the model transcript. Clients send it on the
 * Streamable HTTP request instead:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 */

export function resolveApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(\S+)/i.exec(auth.trim());
    if (match) return match[1];
  }
  const x = headers.get("x-api-key")?.trim();
  return x && x.length > 0 ? x : null;
}

export const MISSING_KEY_MESSAGE =
  "Authenticated MCP tools need Authorization: Bearer <key> or x-api-key on the MCP HTTP request. Do not pass apiKey as a tool argument.";

export function missingKeyResult(): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { ok: false, error: "not_authenticated", message: MISSING_KEY_MESSAGE },
          null,
          2,
        ),
      },
    ],
  };
}
