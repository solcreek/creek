/**
 * R2 ndjson writer.
 *
 * Append-style writes are not native to R2 (objects are immutable),
 * so we batch within a single tail() invocation and write one object
 * per (team, project, hour, scriptType, batchId). We don't coordinate
 * sequence numbers across Tail Worker isolates; instead the batchId
 * starts with the time of the batch's newest entry (see `batchId`), so
 * the reader can order batches by it without an extra R2 read.
 *
 * Key shape (matches creek-observability-design.md):
 *   logs/{team}/{project}/{YYYY-MM-DD}/{HH}-{scriptType}-{batchId}.ndjson
 */

import type { LogEntry, PlatformLogEntry } from "./types.js";

export interface R2WriterEnv {
  LOGS_BUCKET: R2Bucket;
}

/**
 * Root prefix for platform (non-tenant) traces.
 *
 * Deliberately NOT under `logs/`: the tenant-facing logs API derives its
 * R2 prefix as `logs/{team}/{project}/` from the authenticated team, so a
 * separate root makes these unreachable by construction — no dependency on
 * which slugs happen to be reserved. Platform traces carry tenant
 * hostnames in their request URLs, so that isolation is load-bearing.
 */
const PLATFORM_PREFIX = "platform-logs";

export async function writeBatchToR2(env: R2WriterEnv, entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  // Group by (team, project, hour, scriptType). One R2 object per group.
  // Keeps the prefix listing tight when readers query a single project.
  const groups = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(entry);
  }

  const writes: Promise<unknown>[] = [];
  for (const [, bucket] of groups) {
    writes.push(writeOne(env, bucket));
  }
  await Promise.all(writes);
}

function writeOne(env: R2WriterEnv, entries: LogEntry[]): Promise<R2Object | null> {
  const first = entries[0];
  const date = new Date(first.timestamp);
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());

  const key = [
    "logs",
    first.team,
    first.project,
    `${yyyy}-${mm}-${dd}`,
    `${hh}-${first.scriptType}-${batchId(entries)}.ndjson`,
  ].join("/");

  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return env.LOGS_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
}

/**
 * Write erroring platform traces under `platform-logs/{script}/…`.
 *
 * Same batching shape as the tenant writer, grouped by (script, hour).
 * Volume is naturally tiny — only traces that carry an exception get
 * here — so there is no separate cap.
 */
export async function writePlatformBatchToR2(
  env: R2WriterEnv,
  entries: PlatformLogEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const groups = new Map<string, PlatformLogEntry[]>();
  for (const entry of entries) {
    const key = `${entry.script}/${hourStamp(entry.timestamp)}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(entry);
  }

  await Promise.all([...groups.values()].map((bucket) => writeOnePlatform(env, bucket)));
}

function writeOnePlatform(env: R2WriterEnv, entries: PlatformLogEntry[]): Promise<R2Object | null> {
  const first = entries[0];
  const date = new Date(first.timestamp);
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());

  const key = [
    PLATFORM_PREFIX,
    // scriptName reaches us from the runtime; keep it from steering the
    // key out of its prefix even if CF ever emits something exotic.
    sanitizeKeySegment(first.script),
    `${yyyy}-${mm}-${dd}`,
    `${hh}-${batchId(entries)}.ndjson`,
  ].join("/");

  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return env.LOGS_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
}

const HOUR_MS = 3_600_000;

/**
 * 12 hex chars: 6 for the milliseconds into the hour of the batch's newest
 * entry (at most 0x36ee7f), then 6 random. Fixed width, so within an hour
 * the ids sort by time; the random half keeps concurrent isolates apart.
 * The hour is the first entry's, matching the key's {HH} segment.
 */
export function batchId(entries: { timestamp: number }[]): string {
  const hourStart = entries[0].timestamp - (entries[0].timestamp % HOUR_MS);
  const newest = Math.max(...entries.map((e) => e.timestamp));
  const offset = Math.min(Math.max(newest - hourStart, 0), HOUR_MS - 1);
  // randomUUID is hex with hyphens; strip them for a pure-hex suffix.
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return offset.toString(16).padStart(6, "0") + random;
}

function sanitizeKeySegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "unknown";
}

function hourStamp(timestamp: number): string {
  const date = new Date(timestamp);
  return (
    date.getUTCFullYear().toString() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours())
  );
}

function groupKey(e: LogEntry): string {
  const date = new Date(e.timestamp);
  const yyyymmddhh =
    date.getUTCFullYear().toString() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours());
  return `${e.team}/${e.project}/${yyyymmddhh}/${e.scriptType}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
