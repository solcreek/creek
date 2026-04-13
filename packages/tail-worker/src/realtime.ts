/**
 * Realtime DO push — fan-out to subscribers of `creek logs --follow`.
 *
 * For each LogEntry, POST to:
 *   ${REALTIME_URL}/{team}-{project}/rooms/logs/broadcast
 * with body:
 *   { type: "log", entry: <LogEntry> }
 * and Authorization: Bearer <HMAC-SHA256(REALTIME_MASTER_KEY, slug)>.
 *
 * Slug = "{team}-{project}" — same shape the dispatch-worker uses for
 * tenant scripts. WebSocket subscribers use this slug to derive their
 * own DO room and the same HMAC key to mint their subscribe token.
 *
 * Best-effort: realtime push failures don't fail the tail() handler.
 * Live subscribers may miss events under transient network failures —
 * they should resync from R2 if they need a complete history.
 *
 * Group entries by slug so we make one HTTP call per slug per batch
 * instead of N. Each call POSTs an array of entries; the DO unpacks
 * and sends each as a separate WebSocket message.
 */

import type { LogEntry } from "./types.js";

export interface RealtimeEnv {
  /** Base URL of the realtime worker, e.g. "https://realtime.creek.dev". */
  REALTIME_URL?: string;
  /** Shared HMAC master key with realtime-worker for per-project auth. */
  REALTIME_MASTER_KEY?: string;
}

export async function pushBatchToRealtime(
  env: RealtimeEnv,
  entries: LogEntry[],
): Promise<void> {
  if (!env.REALTIME_URL || !env.REALTIME_MASTER_KEY) return; // not configured (dev)
  if (entries.length === 0) return;

  const bySlug = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const slug = `${entry.team}-${entry.project}`;
    let bucket = bySlug.get(slug);
    if (!bucket) {
      bucket = [];
      bySlug.set(slug, bucket);
    }
    bucket.push(entry);
  }

  const masterKey = env.REALTIME_MASTER_KEY;
  const realtimeUrl = env.REALTIME_URL;
  const tasks: Promise<void>[] = [];
  for (const [slug, bucket] of bySlug) {
    tasks.push(pushOne(realtimeUrl, masterKey, slug, bucket));
  }
  const results = await Promise.allSettled(tasks);
  // Best-effort: log failures but don't bubble up. Tail handler
  // failures stop R2 + AE from completing; realtime is a nice-to-have.
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[tail/realtime] push failed:", r.reason);
    }
  }
}

async function pushOne(
  baseUrl: string,
  masterKey: string,
  slug: string,
  entries: LogEntry[],
): Promise<void> {
  const token = await hmacSlug(masterKey, slug);
  // One message per entry — DO broadcasts each separately so clients
  // can render incrementally instead of seeing batch-of-N at once.
  // Group POST to amortize HTTP overhead but keep WS payload granular.
  const body = entries.map((e) => ({ type: "log", entry: e }));

  const url = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(slug)}/rooms/logs/broadcast`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body[0]), // see TODO below
  });
  if (!res.ok) {
    throw new Error(`realtime POST ${slug} → ${res.status}`);
  }
  // TODO: realtime DO `/broadcast` currently consumes one event per
  // POST. For batched push we'd need to either (a) loop POSTs here
  // (chatty) or (b) extend DO to accept arrays. Keeping it one-event
  // for the MVP — typical tail batches are 1-3 entries, and the DO
  // call is cheap (same DC). Bump to (b) if we see batch sizes >5.
  for (let i = 1; i < body.length; i++) {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body[i]),
    });
  }
}

async function hmacSlug(masterKey: string, slug: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(slug),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
