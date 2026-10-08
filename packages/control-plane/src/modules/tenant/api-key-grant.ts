import type { D1Database } from "@cloudflare/workers-types";
import { isScope, type Scope } from "./scopes.js";

/**
 * What an API key is allowed to do, read from its `apikey` row.
 *
 * - `legacy`: the key predates scopes (`permissions` is NULL). It keeps the
 *   full access of its owner, as before.
 * - `scoped`: the key holds `scopes` and is pinned to `teamId`.
 * - `invalid`: `permissions` is set but unreadable. It grants nothing.
 *
 * Scopes live in the plugin's `permissions` column because Better Auth only
 * lets the server write it (clients get SERVER_ONLY_PROPERTY); `metadata`
 * is client-writable, so it must never carry authorization.
 *
 * Stored shape: {"creek": ["deploy:preview", ...], "creekTeam": ["<team id>"]}
 */
export type ApiKeyGrant =
  | { kind: "legacy"; keyId: string }
  | { kind: "scoped"; keyId: string; scopes: ReadonlySet<Scope>; teamId: string }
  | { kind: "invalid"; keyId: string };

/** Build the `permissions` value for a scoped key. */
export function scopedKeyPermissions(
  scopes: readonly Scope[],
  teamId: string,
): Record<string, string[]> {
  return { creek: [...new Set(scopes)], creekTeam: [teamId] };
}

/** Parse a stored `permissions` value. Anything unexpected is `invalid`. */
export function parseGrant(keyId: string, permissions: string | null): ApiKeyGrant {
  if (permissions === null) return { kind: "legacy", keyId };
  let parsed: unknown;
  try {
    parsed = JSON.parse(permissions);
  } catch {
    return { kind: "invalid", keyId };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", keyId };
  }
  const { creek, creekTeam } = parsed as Record<string, unknown>;
  if (!Array.isArray(creek) || !creek.every((s) => typeof s === "string")) {
    return { kind: "invalid", keyId };
  }
  if (
    !Array.isArray(creekTeam) ||
    creekTeam.length !== 1 ||
    typeof creekTeam[0] !== "string" ||
    creekTeam[0].length === 0
  ) {
    return { kind: "invalid", keyId };
  }
  // A scope this build doesn't know (a typo, or one from a newer build after
  // a rollback) grants nothing.
  const scopes = new Set(creek.filter(isScope));
  return { kind: "scoped", keyId, scopes, teamId: creekTeam[0] };
}

/**
 * Load the grant for the key behind an API-key session. Better Auth sets the
 * session id to the apikey row id. Returns null when no apikey row has that
 * id or it belongs to someone else — i.e. the session is not an API key's.
 */
export async function loadApiKeyGrant(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<ApiKeyGrant | null> {
  const row = await db
    .prepare("SELECT id, referenceId, permissions FROM apikey WHERE id = ?")
    .bind(sessionId)
    .first<{ id: string; referenceId: string; permissions: string | null }>();
  if (!row || row.referenceId !== userId) return null;
  return parseGrant(row.id, row.permissions);
}
