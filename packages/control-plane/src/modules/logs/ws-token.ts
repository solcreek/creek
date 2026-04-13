/**
 * Mint a 5-minute WebSocket subscribe token for the logs room.
 *
 * Mirrors realtime-worker's verifyWsToken format:
 *   token = "{unixSeconds}.{hmac}"
 *   hmac  = HMAC-SHA256(perProjectSecret, "{slug}:ws:{unixSeconds}")
 *   perProjectSecret = HMAC-SHA256(masterKey, slug)
 *
 * Slug for logs: "{team}-{project}" — same as the room name
 * tail-worker pushes to (see tail-worker/src/realtime.ts).
 *
 * If REALTIME_MASTER_KEY isn't set (dev), returns null so the route
 * can degrade gracefully.
 */

import { deriveRealtimeSecret } from "../realtime/hmac.js";

export async function mintLogsWsToken(opts: {
  masterKey: string | undefined;
  team: string;
  project: string;
}): Promise<{ token: string; expiresAt: number; slug: string } | null> {
  if (!opts.masterKey) return null;
  const slug = `${opts.team}-${opts.project}`;
  const ts = Math.floor(Date.now() / 1000);
  const perProjectSecret = await deriveRealtimeSecret(opts.masterKey, slug);

  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(perProjectSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${slug}:ws:${ts}`),
  );
  const hmac = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    token: `${ts}.${hmac}`,
    expiresAt: (ts + 5 * 60) * 1000,
    slug,
  };
}

/**
 * realtime-worker derives perProjectSecret as a hex STRING then uses
 * that string's bytes as the HMAC key (see verifyWsToken). Mirror
 * that behaviour exactly — passing the parsed bytes would yield a
 * different signature and tokens would 401.
 */
function hexToBytes(hex: string): Uint8Array {
  return new TextEncoder().encode(hex);
}
