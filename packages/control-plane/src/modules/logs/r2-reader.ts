/**
 * R2 reader for log archive.
 *
 * R2 key shape (from tail-worker/src/r2-writer.ts):
 *   logs/{team}/{project}/{YYYY-MM-DD}/{HH}-{scriptType}-{batchId}.ndjson
 *
 * To answer a time-range query we (1) compute which (date, hour)
 * buckets fall inside the range, (2) list each bucket's prefix from
 * R2, (3) GET each ndjson file, (4) parse + filter + collect.
 *
 * Tenant isolation: caller MUST pass the team slug derived from the
 * authenticated session. Project slug comes from the URL param after
 * a permission check. The R2 prefix `logs/{team}/{project}/` is
 * server-derived and never trusted from user input.
 *
 * Cost/perf: we cap the number of R2 LIST + GET calls per request.
 * One LIST per hour bucket, one GET per ndjson object. A 1h window
 * with 100 distinct batches = ~101 R2 ops. The reader stops early
 * once `limit` matching entries are collected.
 */

import type { LogEntry, LogQuery } from "./types.js";
import { matchesQuery } from "./query.js";

const MAX_R2_OPS = 500; // safety net — never make >500 R2 calls per query

export interface ReadLogsInput {
  bucket: R2Bucket;
  team: string;
  project: string;
  query: LogQuery;
}

export interface ReadLogsResult {
  entries: LogEntry[];
  /** Whether more results were available beyond the limit. */
  truncated: boolean;
  /** R2 ops we made — exposed for observability/debugging. */
  r2Ops: number;
}

export async function readLogs(input: ReadLogsInput): Promise<ReadLogsResult> {
  const { bucket, team, project, query } = input;
  const prefixes = hourPrefixes(team, project, query.sinceMs, query.untilMs);

  const entries: LogEntry[] = [];
  let r2Ops = 0;
  let truncated = false;

  // Walk newest hour first so the limit collects the most recent
  // entries when truncated. prefixes is already chronological;
  // reverse for descending.
  for (const prefix of prefixes.reverse()) {
    if (entries.length >= query.limit) {
      truncated = true;
      break;
    }
    if (r2Ops >= MAX_R2_OPS) {
      truncated = true;
      break;
    }

    const list = await bucket.list({ prefix });
    r2Ops++;
    if (!list.objects.length) continue;

    // Within a single hour, lex order ≈ creation order. Reverse so
    // newer batches come first within the hour too.
    const objects = [...list.objects].reverse();
    for (const obj of objects) {
      if (entries.length >= query.limit) {
        truncated = true;
        break;
      }
      if (r2Ops >= MAX_R2_OPS) {
        truncated = true;
        break;
      }

      const got = await bucket.get(obj.key);
      r2Ops++;
      if (!got) continue;

      const text = await got.text();
      const lines = text.split("\n");
      // Reverse lines so newer entries come first within a batch.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let entry: LogEntry;
        try {
          entry = JSON.parse(line) as LogEntry;
        } catch {
          continue;
        }
        if (!matchesQuery(entry, query)) continue;
        entries.push(entry);
        if (entries.length >= query.limit) {
          // We stopped early — there could be more matching entries
          // either in remaining lines of this object, in remaining
          // objects of this hour, or in remaining hours.
          truncated = true;
          break;
        }
      }
    }
  }

  return { entries, truncated, r2Ops };
}

/**
 * Compute the list of `logs/{team}/{project}/{YYYY-MM-DD}/{HH}-`
 * prefixes that intersect [sinceMs, untilMs]. Step is 1 hour. Returns
 * chronological order; caller may reverse for newest-first reads.
 */
export function hourPrefixes(
  team: string,
  project: string,
  sinceMs: number,
  untilMs: number,
): string[] {
  const out: string[] = [];
  // Floor since to the hour, ceil until to the hour.
  const start = Math.floor(sinceMs / 3_600_000) * 3_600_000;
  const end = Math.ceil(untilMs / 3_600_000) * 3_600_000;
  for (let t = start; t < end; t += 3_600_000) {
    const d = new Date(t);
    const yyyy = d.getUTCFullYear();
    const mm = pad2(d.getUTCMonth() + 1);
    const dd = pad2(d.getUTCDate());
    const hh = pad2(d.getUTCHours());
    out.push(`logs/${team}/${project}/${yyyy}-${mm}-${dd}/${hh}-`);
  }
  return out;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
