/**
 * Daily metering aggregator.
 *
 * Reads yesterday's `creek_tenant_requests` rows from Analytics Engine,
 * groups by (team, project), and upserts into the `usage_daily` D1
 * table. Runs from control-plane's scheduled() handler; idempotent via
 * (teamSlug, projectSlug, date) primary key so re-running mid-day or
 * across multiple 5-min cron ticks is safe.
 *
 * Phase 1 scope: request + error counts only. cpuMs / bytesOut require
 * tail-worker changes to capture those signals per event; when those
 * land, extend the SELECT here and the schema in lockstep.
 *
 * AE column mapping (mirror of tail-worker/src/analytics.ts):
 *   blob1  — team slug
 *   blob2  — project slug
 *   double1 — count (always 1)
 *   double2 — isError (0 or 1)
 *   _sample_interval — AE's weight per row; multiply into aggregates
 */

import { querySql } from "../metrics/ae-sql.js";

export interface MeteringEnv {
  DB: D1Database;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

/** Date string YYYY-MM-DD in UTC for a given Date. */
export function utcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The UTC day that just ended at `now`. */
export function yesterdayUTC(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDateString(d);
}

/**
 * AE SQL to group yesterday's rows by team+project. Date bounds are
 * computed with the day string so the half-open interval matches the
 * usage_daily row for that date exactly.
 *
 * We don't need quote() escaping — `date` is produced by utcDateString,
 * which is strictly YYYY-MM-DD.
 */
export function buildAggregateSql(date: string): string {
  return `
    SELECT
      blob1 AS team,
      blob2 AS project,
      SUM(double1 * _sample_interval) AS requests,
      SUM(double2 * _sample_interval) AS errors
    FROM creek_tenant_requests
    WHERE timestamp >= toDateTime('${date} 00:00:00')
      AND timestamp <  toDateTime('${date} 00:00:00') + INTERVAL '1' DAY
      AND blob1 != ''
      AND blob2 != ''
    GROUP BY team, project
    FORMAT JSON
  `.trim();
}

interface AggregateRow {
  team: string;
  project: string;
  requests: number | null;
  errors: number | null;
}

/**
 * Aggregate yesterday's AE data and upsert into usage_daily. Returns
 * the number of rows written (one per active team+project).
 */
export async function aggregateYesterday(
  env: MeteringEnv,
  now = new Date(),
): Promise<{ date: string; rows: number }> {
  const date = yesterdayUTC(now);
  const sql = buildAggregateSql(date);
  const result = await querySql<AggregateRow>(env, sql);

  if (result.data.length === 0) {
    return { date, rows: 0 };
  }

  // Upsert each (team, project, date) — idempotent under the composite
  // PK so re-running the cron doesn't double-count.
  const stmt = env.DB.prepare(
    `INSERT INTO usage_daily (teamSlug, projectSlug, date, requests, errors, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(teamSlug, projectSlug, date) DO UPDATE SET
       requests = excluded.requests,
       errors = excluded.errors,
       createdAt = excluded.createdAt`,
  );

  const createdAt = Math.floor(now.getTime() / 1000);
  const batch = result.data.map((row) =>
    stmt.bind(
      row.team,
      row.project,
      date,
      Math.round(row.requests ?? 0),
      Math.round(row.errors ?? 0),
      createdAt,
    ),
  );

  await env.DB.batch(batch);
  return { date, rows: result.data.length };
}
