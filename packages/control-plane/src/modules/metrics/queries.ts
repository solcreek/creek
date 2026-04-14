/**
 * SQL query builders for the `creek_tenant_requests` AE dataset.
 *
 * AE column shape (mirror of tail-worker/src/analytics.ts):
 *   index1  — team (duplicated for pre-filter)
 *   blob1   — team
 *   blob2   — project
 *   blob3   — scriptType  (production | branch | deployment)
 *   blob4   — outcome     (8 TailOutcome values)
 *   blob5   — method      (HTTP verb or "n/a")
 *   blob6   — statusBucket ("2xx" | "3xx" | "4xx" | "5xx" | "1xx" | "n/a")
 *   double1 — count       (always 1 per event)
 *   double2 — isError     (0 or 1)
 *   _sample_interval — AE's per-row weight; multiply into aggregates
 *
 * Tenant scoping is enforced by requiring `team` + `project` on every
 * query. Callers MUST pass values from the authenticated session.
 * Values go through quote() in ae-sql.ts before interpolation — slugs
 * are also constrained to [a-z0-9-] at schema level as defence-in-depth.
 */

import { quote } from "./ae-sql.js";

/** Bucket width for time-series queries, chosen from the period. */
function bucketSeconds(periodHours: number): number {
  // ~60 buckets per window: 1h → 1min, 24h → 24min, 7d → ~3h
  if (periodHours <= 1) return 60;
  if (periodHours <= 6) return 5 * 60;
  if (periodHours <= 24) return 15 * 60;
  if (periodHours <= 24 * 7) return 60 * 60;
  return 60 * 60 * 6;
}

export interface QueryScope {
  team: string;
  project: string;
  periodHours: number;
}

export function totalsSql(scope: QueryScope): string {
  return `
    SELECT
      SUM(double1 * _sample_interval) AS reqs,
      SUM(double2 * _sample_interval) AS errs
    FROM creek_tenant_requests
    WHERE blob1 = ${quote(scope.team)}
      AND blob2 = ${quote(scope.project)}
      AND timestamp > NOW() - INTERVAL '${scope.periodHours}' HOUR
    FORMAT JSON
  `.trim();
}

export function timeseriesSql(scope: QueryScope): string {
  const bucket = bucketSeconds(scope.periodHours);
  return `
    SELECT
      intDiv(toUInt32(timestamp), ${bucket}) * ${bucket} AS bucket,
      SUM(double1 * _sample_interval) AS reqs,
      SUM(double2 * _sample_interval) AS errs
    FROM creek_tenant_requests
    WHERE blob1 = ${quote(scope.team)}
      AND blob2 = ${quote(scope.project)}
      AND timestamp > NOW() - INTERVAL '${scope.periodHours}' HOUR
    GROUP BY bucket
    ORDER BY bucket
    FORMAT JSON
  `.trim();
}

export type BreakdownDimension = "method" | "scriptType" | "statusBucket" | "outcome";

const DIMENSION_BLOB: Record<BreakdownDimension, string> = {
  scriptType: "blob3",
  outcome: "blob4",
  method: "blob5",
  statusBucket: "blob6",
};

export function breakdownSql(
  scope: QueryScope,
  dimension: BreakdownDimension,
  limit = 20,
): string {
  const col = DIMENSION_BLOB[dimension];
  return `
    SELECT
      ${col} AS label,
      SUM(double1 * _sample_interval) AS reqs,
      SUM(double2 * _sample_interval) AS errs
    FROM creek_tenant_requests
    WHERE blob1 = ${quote(scope.team)}
      AND blob2 = ${quote(scope.project)}
      AND timestamp > NOW() - INTERVAL '${scope.periodHours}' HOUR
    GROUP BY label
    ORDER BY reqs DESC
    LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}
    FORMAT JSON
  `.trim();
}
