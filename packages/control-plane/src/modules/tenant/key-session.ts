import type { Context } from "hono";
import type { Env } from "../../types.js";
import { createAuth } from "./auth.js";
import { loadApiKeyGrant } from "./api-key-grant.js";
import { isApiKeyRequest } from "./scope-guard.js";

/**
 * For the one Better Auth endpoint a key may call (get-session, which CLI
 * login and whoami use): refuse a key that every other route would refuse,
 * so whoami cannot report a session for a key that can do nothing. Returns
 * a response to send, or null to let Better Auth answer.
 *
 * A key Better Auth itself rejects (unknown, disabled, expired) is left to
 * Better Auth, which answers that one.
 */
export async function refuseUnusableKeySession(c: Context): Promise<Response | null> {
  if (!isApiKeyRequest(c)) return null;
  const env = c.env as Env;
  let session: Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>;
  try {
    session = await createAuth(env).api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status !== 401 && status !== 403) throw err;
    return null;
  }
  if (!session?.user) return null;

  const grant = await loadApiKeyGrant(env.DB, session.session.id, session.user.id);
  if (!grant) {
    return c.json({ error: "unauthorized", message: "Missing or invalid authentication" }, 401);
  }
  if (grant.kind === "invalid") {
    return c.json(
      { error: "invalid_key_scopes", message: "This API key's scopes are unreadable" },
      403,
    );
  }
  if (grant.kind === "scoped") {
    const member = await env.DB.prepare(
      "SELECT 1 AS ok FROM member WHERE userId = ? AND organizationId = ?",
    )
      .bind(session.user.id, grant.teamId)
      .first<{ ok: number }>();
    if (!member) {
      return c.json(
        {
          error: "team_mismatch",
          message: "This API key is limited to a team its owner is no longer a member of",
        },
        403,
      );
    }
  }
  return null;
}
