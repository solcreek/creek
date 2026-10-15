import type { D1Database } from "@cloudflare/workers-types";
import type { Context } from "hono";
import { squashPath } from "../tenant/api-key-metadata.js";

/**
 * The per-user cap on API keys.
 *
 * A user may hold at most MAX_ACTIVE_KEYS keys that have not expired. Legacy
 * and scoped keys count alike, and so do disabled keys: Better Auth's own
 * update endpoint can re-enable a key, so a disabled key still holds a slot.
 *
 * Both ways of minting a key enforce it: POST /api-keys, and Better Auth's
 * POST /api/auth/api-key/create (session-only, used by the dashboard until it
 * moves to POST /api-keys; see enforceKeyCapOnAuthCreate).
 *
 * Exact under concurrency, in the safe direction. Each mint checks twice:
 * - before minting, so a user at the cap never creates a row at all;
 * - after its row is written, counting again; if the user now holds more
 *   than the cap, the new key is deleted (by its own id) and the mint is
 *   refused.
 * Every surviving key saw at most MAX_ACTIVE_KEYS rows after its own insert,
 * and the last survivor to check saw every other survivor, so the cap is
 * never exceeded. The price: two mints racing for the last slot may both be
 * refused (each sees the other's row), and the caller retries. That is
 * acceptable for a 50-key limit no ordinary user comes near.
 */
export const MAX_ACTIVE_KEYS = 50;

/** The user's keys that have not expired, legacy, scoped or disabled alike. */
export async function countActiveKeys(db: D1Database, userId: string): Promise<number> {
  // expiresAt is epoch seconds (Better Auth's drizzle timestamp mode).
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM apikey WHERE referenceId = ? AND (expiresAt IS NULL OR expiresAt > ?)",
    )
    .bind(userId, Math.floor(Date.now() / 1000))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The 409 a mint at the cap answers. */
export function keyLimitResponse(c: Context, active: number): Response {
  return c.json(
    {
      error: "key_limit_reached",
      message: `You have ${active} active API keys; the limit is ${MAX_ACTIVE_KEYS} per user. Revoke keys you no longer use (DELETE /api-keys/:id, or the dashboard) before creating another.`,
      limit: MAX_ACTIVE_KEYS,
      active,
    },
    409,
  );
}

/** Whether a path names Better Auth's key-create endpoint, however it is spelled. */
export function isAuthKeyCreatePath(pathname: string): boolean {
  return squashPath(pathname).includes("apikeycreate");
}

/**
 * Apply the cap to Better Auth's own POST /api/auth/api-key/create, which
 * mints a legacy (full-access) key and would otherwise step around it.
 * `run` calls Better Auth. Requests that are not a key create, and requests
 * with no session (Better Auth answers those), pass straight through.
 */
export async function enforceKeyCapOnAuthCreate(
  c: Context,
  db: D1Database,
  getUserId: () => Promise<string | null>,
  run: () => Promise<Response>,
): Promise<Response> {
  if (c.req.method.toUpperCase() !== "POST" || !isAuthKeyCreatePath(new URL(c.req.url).pathname)) {
    return run();
  }
  const userId = await getUserId();
  if (!userId) return run();

  const before = await countActiveKeys(db, userId);
  if (before >= MAX_ACTIVE_KEYS) return keyLimitResponse(c, before);

  const res = await run();
  if (res.status !== 200) return res;
  let id: unknown;
  try {
    id = ((await res.clone().json()) as { id?: unknown }).id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string") return res;

  let after: number;
  try {
    after = await countActiveKeys(db, userId);
  } catch (err) {
    console.error(`[api-keys] cap check after creating key ${id} failed:`, err);
    await deleteOwnKey(db, id, userId);
    return c.json(
      { error: "key_create_failed", message: "API key creation failed; no key was created" },
      500,
    );
  }
  if (after > MAX_ACTIVE_KEYS) {
    await deleteOwnKey(db, id, userId);
    return keyLimitResponse(c, after - 1);
  }
  return res;
}

async function deleteOwnKey(db: D1Database, id: string, userId: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM apikey WHERE id = ? AND referenceId = ?").bind(id, userId).run();
  } catch (err) {
    console.error(`[api-keys] CRITICAL: delete of key ${id} over the cap failed:`, err);
  }
}
