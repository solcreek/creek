import type { Context } from "hono";

/**
 * Keep API key `metadata` server-only.
 *
 * The api-key plugin has `enableMetadata` on so that POST /api-keys can tag
 * each key it mints (api-keys/service.ts). That also opens metadata to
 * clients on Better Auth's own endpoints (`/api-key/create`,
 * `/api-key/update`), with no schema and no size limit. This refuses any
 * client request to an api-key endpoint that carries a `metadata` field, so
 * only the server-side `auth.api.createApiKey` can set it.
 *
 * Bypass-resistant by construction rather than by matching Better Auth's
 * parsing:
 * - Any non-GET/HEAD request under /api/auth/ whose path mentions
 *   "api-key" in any spelling (percent-decoded, any case, any slashes) is
 *   checked, not just the two exact paths.
 * - Its body must be empty or JSON with exactly `application/json` as the
 *   media type; anything else (form, multipart, text, missing type, JSON
 *   variants) is refused, so Better Auth can never parse it differently.
 * - The body is parsed here with JSON.parse, which is what Better Auth
 *   uses for JSON, and a top-level `metadata` key (however escaped, even
 *   null) is refused.
 *
 * Returns a response to send, or null to let Better Auth answer.
 */
export async function refuseClientKeyMetadata(c: Context): Promise<Response | null> {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  if (!mentionsApiKey(new URL(c.req.url).pathname)) return null;

  const text = await c.req.raw.clone().text();
  if (text.length === 0) return null;

  const mediaType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return c.json(
      {
        error: "unsupported_media_type",
        message: "API key endpoints accept only application/json bodies",
      },
      415,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "validation", message: "The body is not valid JSON" }, 400);
  }
  if (
    body !== null &&
    typeof body === "object" &&
    Object.prototype.hasOwnProperty.call(body, "metadata")
  ) {
    return c.json(
      {
        error: "metadata_not_allowed",
        message: "API key metadata is set by the server only",
      },
      400,
    );
  }
  return null;
}

/** Whether a path names an api-key endpoint, however it is spelled. */
function mentionsApiKey(pathname: string): boolean {
  let path = pathname;
  // Decode repeatedly (bounded) so %2D, %252D and the like all collapse.
  for (let i = 0; i < 5; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .includes("apikey");
}
