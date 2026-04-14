/**
 * Thin wrapper over Cloudflare Analytics Engine SQL API.
 *
 * AE SQL is the READ side of the `creek_tenant_requests` dataset
 * tail-worker writes to. The endpoint accepts raw SQL and returns
 * rows as JSON. We keep this helper minimal (one fetch call) because
 * AE-SQL-specific quirks (column naming `blob1..blobN`, `double1..`,
 * `_sample_interval`) belong in the per-query SQL strings, not in
 * shared wrapper types.
 *
 * Tenant isolation: callers MUST pass a WHERE clause filtering on
 * blob1 (team). This helper does NOT auto-scope — it's a thin
 * transport. The metrics routes layer is responsible for building
 * safe SQL from an authenticated session's teamSlug.
 *
 * Cost: AE SQL queries are included in the Workers paid plan up to
 * 10M events scanned/day. We keep result sets small and always
 * bound by a time range to avoid surprise scans.
 */

export interface AeSqlEnv {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

export interface AeSqlResult<Row = Record<string, unknown>> {
  meta: Array<{ name: string; type: string }>;
  data: Row[];
  rows: number;
  rows_before_limit_at_least?: number;
}

export async function querySql<Row = Record<string, unknown>>(
  env: AeSqlEnv,
  sql: string,
): Promise<AeSqlResult<Row>> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: sql,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AE SQL ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AeSqlResult<Row>;
}

/**
 * Quote a string for inclusion in SQL. Only handles ClickHouse-style
 * single-quote escaping. We use this for team/project slugs, which
 * the database already constrains to [a-z0-9-]. The quoting is
 * defence-in-depth — a malformed slug still won't break out.
 */
export function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
