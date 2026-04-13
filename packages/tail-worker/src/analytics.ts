/**
 * Workers Analytics Engine writer.
 *
 * Aggregate counters per (team, project, scriptType, outcome, method,
 * statusBucket). One data point per LogEntry. AE is auto-created on
 * first write, so no provisioning step.
 *
 * Why this complements R2: R2 keeps the raw events for drill-down +
 * `creek logs` browsing. AE answers aggregate questions cheaply via
 * SQL — request count, error rate, breakdowns by HTTP method etc. —
 * without scanning ndjson files. Dashboard metrics tab will read
 * from AE; log viewer will read from R2.
 *
 * Dimensions chosen for low cardinality so SQL aggregates stay fast:
 *   - team / project: tenant identity (always filtered on)
 *   - scriptType: production vs branch vs deployment preview
 *   - outcome: 8 possible values
 *   - method: HTTP verb (GET/POST/...) or "n/a" for non-fetch events
 *   - statusBucket: "2xx" / "3xx" / "4xx" / "5xx" / "n/a"
 *
 * URL is intentionally NOT a dimension — high cardinality kills AE.
 * For per-URL drill-down, query R2 raw logs instead.
 *
 * Index: team — AE supports a single index column used for
 * pre-filtering. Most queries are tenant-scoped, so team wins.
 */

import type { LogEntry } from "./types.js";

export interface AnalyticsEnv {
  ANALYTICS: AnalyticsEngineDataset;
}

export function writeBatchToAnalytics(
  env: AnalyticsEnv,
  entries: LogEntry[],
): void {
  for (const entry of entries) {
    env.ANALYTICS.writeDataPoint({
      indexes: [entry.team],
      blobs: [
        entry.team,
        entry.project,
        entry.scriptType,
        entry.outcome,
        entry.request?.method ?? "n/a",
        statusBucket(entry.request?.status),
      ],
      doubles: [
        1, // always count one
        isError(entry) ? 1 : 0,
      ],
    });
  }
}

function statusBucket(status: number | undefined): string {
  if (status === undefined) return "n/a";
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

function isError(entry: LogEntry): boolean {
  if (entry.outcome !== "ok") return true;
  if (entry.exceptions.length > 0) return true;
  if (entry.request?.status !== undefined && entry.request.status >= 500) return true;
  return false;
}
