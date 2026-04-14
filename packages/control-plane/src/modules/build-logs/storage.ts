/**
 * Build-log persistence: scrub → gzip → R2 PUT → D1 upsert.
 *
 * Sized to be called once per deployment at terminal time. Streaming
 * (line-by-line append) is Phase 2 — for Phase 1 we accept that the
 * log isn't visible until the build finishes.
 *
 * Truncation policy:
 *   - Cap raw input at MAX_LOG_BYTES; everything past it is dropped
 *     and `truncated=true` is recorded. We keep the head, not the
 *     tail, because the head usually identifies the failing step.
 *   - Also cap line count to defend against pathological inputs.
 */

import { scrubNdjson } from "./scrub.js";
import {
  MAX_LOG_BYTES,
  MAX_LOG_LINES,
  type BuildLogStatus,
} from "./types.js";

export interface StoreEnv {
  DB: D1Database;
  LOGS_BUCKET?: R2Bucket;
}

export interface StoreInput {
  team: string;
  project: string;
  deploymentId: string;
  status: BuildLogStatus;
  startedAt: number;
  endedAt: number;
  body: string; // ndjson
  errorCode?: string | null;
  errorStep?: string | null;
}

export interface StoreResult {
  bytes: number; // compressed
  lines: number;
  truncated: boolean;
  r2Key: string;
}

/** Truncate a string at byte boundary by line. Returns the head + a
 *  flag indicating something was dropped. */
function truncateByBytes(body: string, maxBytes: number): { text: string; truncated: boolean; lines: number } {
  // Quick path — most inputs fit comfortably.
  const enc = new TextEncoder();
  const bytes = enc.encode(body).length;
  let lines = 0;
  for (const ch of body) if (ch === "\n") lines++;
  if (body.length > 0 && !body.endsWith("\n")) lines++;

  if (bytes <= maxBytes && lines <= MAX_LOG_LINES) {
    return { text: body, truncated: false, lines };
  }

  // Walk lines and accumulate up to the byte cap, also bounded by line count.
  const split = body.split("\n");
  const out: string[] = [];
  let runningBytes = 0;
  for (const line of split) {
    if (out.length >= MAX_LOG_LINES) break;
    const lineBytes = enc.encode(line).length + 1; // +1 for \n
    if (runningBytes + lineBytes > maxBytes) break;
    out.push(line);
    runningBytes += lineBytes;
  }
  const head = out.join("\n") + "\n";
  // Append a marker line so readers know why content stopped.
  const marker = JSON.stringify({
    ts: Date.now(),
    step: "cleanup",
    stream: "creek",
    level: "warn",
    msg: `[creek] log truncated — original was ${bytes} bytes / ${lines} lines, capped to ${MAX_LOG_BYTES} bytes / ${MAX_LOG_LINES} lines`,
  }) + "\n";
  return { text: head + marker, truncated: true, lines: out.length + 1 };
}

async function gzip(input: string): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(new CompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function buildR2Key(team: string, project: string, deploymentId: string): string {
  return `builds/${team}/${project}/${deploymentId}.ndjson.gz`;
}

/**
 * Run the full pipeline. Returns metadata for the upserted row.
 * Caller is responsible for authentication + ownership checks.
 */
export async function storeBuildLog(env: StoreEnv, input: StoreInput): Promise<StoreResult> {
  if (!env.LOGS_BUCKET) {
    throw new Error("LOGS_BUCKET binding not configured");
  }

  const { text: capped, truncated, lines } = truncateByBytes(input.body, MAX_LOG_BYTES);
  const { text: scrubbed } = scrubNdjson(capped);
  const compressed = await gzip(scrubbed);
  const r2Key = buildR2Key(input.team, input.project, input.deploymentId);

  await env.LOGS_BUCKET.put(r2Key, compressed, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
    customMetadata: {
      team: input.team,
      project: input.project,
      deploymentId: input.deploymentId,
      status: input.status,
    },
  });

  // INSERT OR REPLACE — idempotent on retries (e.g. CLI POST after a
  // remote-builder POST also lands).
  await env.DB.prepare(
    `INSERT INTO build_log (deploymentId, status, startedAt, endedAt, bytes, lines, truncated, errorCode, errorStep, r2Key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deploymentId) DO UPDATE SET
       status = excluded.status,
       endedAt = excluded.endedAt,
       bytes = excluded.bytes,
       lines = excluded.lines,
       truncated = excluded.truncated,
       errorCode = excluded.errorCode,
       errorStep = excluded.errorStep,
       r2Key = excluded.r2Key`,
  )
    .bind(
      input.deploymentId,
      input.status,
      input.startedAt,
      input.endedAt,
      compressed.byteLength,
      lines,
      truncated ? 1 : 0,
      input.errorCode ?? null,
      input.errorStep ?? null,
      r2Key,
    )
    .run();

  return {
    bytes: compressed.byteLength,
    lines,
    truncated,
    r2Key,
  };
}
