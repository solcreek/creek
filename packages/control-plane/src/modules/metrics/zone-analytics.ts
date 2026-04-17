/**
 * Zone-level HTTP analytics via CF GraphQL `httpRequestsAdaptiveGroups`.
 *
 * Why this exists alongside AE metrics:
 *   - AE (`creek_tenant_requests`) is written by tail-worker → only
 *     captures events when the user script ACTUALLY RUNS. CF edge
 *     cache hits (common for SPA index.html) bypass the worker, so
 *     AE under-counts real traffic.
 *   - Zone-level HTTP analytics is the CDN's own request log; it
 *     includes cached + uncached. Source of truth for "how many
 *     visits did this site receive".
 *
 * We query by hostname: `{project}-{team}.bycreek.com`. Custom domains
 * live on a different zone and aren't covered by this helper yet.
 *
 * Zone ID resolution: we don't ship a BYCREEK_ZONE_ID env var — we
 * look it up once per isolate via REST (`/zones?name=`) and cache in
 * module scope. The CLOUDFLARE_API_TOKEN secret already has read
 * access to zones.
 */
import type { Env } from "../../types.js";

interface ZoneTotals {
  reqs: number;
  cachedReqs: number;
  errs: number;
}

interface ZoneSeriesPoint {
  t: number;
  reqs: number;
  cachedReqs: number;
}

export interface ZoneHttpAnalytics {
  totals: ZoneTotals;
  series: ZoneSeriesPoint[];
}

/**
 * Extract the registrable zone name from a fully-qualified hostname.
 * Heuristic: take the last two labels. Works for .com / .dev / .io /
 * most TLDs we see in practice. Multi-level TLDs (.co.uk, .com.tw)
 * would need PSL-aware parsing — zone lookup just fails for those
 * and the caller degrades gracefully, so no wrong-zone damage.
 */
export function extractZoneName(hostname: string): string {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;
  return labels.slice(-2).join(".");
}

// --- Zone ID cache (one lookup per isolate, per zone name) ---
const zoneIdCache = new Map<string, string>();

async function getZoneId(env: Env, zoneName: string): Promise<string | null> {
  const cached = zoneIdCache.get(zoneName);
  if (cached) return cached;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: Array<{ id: string }> };
  const id = data.result?.[0]?.id ?? null;
  if (id) zoneIdCache.set(zoneName, id);
  return id;
}

/**
 * httpRequestsAdaptiveGroups is the only zone dataset that supports
 * per-host filtering (clientRequestHTTPHost). Its request count lives
 * on the top-level `count` field — NOT `sum.requests`, which only
 * exists on httpRequests1h/1dGroups (which in turn don't support host
 * filters). Cache-hit split comes from issuing a second query with
 * cacheStatus="hit".
 *
 * Bucket dimension is picked so series rows stay under ~720:
 *   ≤ 1h   → 5-minute buckets  (up to 12)
 *   ≤ 24h  → 15-minute buckets (up to 96)
 *   ≤ 7d   → 1-hour buckets    (up to 168)
 *   > 7d   → 1-day buckets     (up to 30)
 */
function bucketDimension(periodHours: number): string {
  if (periodHours <= 1) return "datetimeFiveMinutes";
  if (periodHours <= 24) return "datetimeFifteenMinutes";
  if (periodHours <= 24 * 7) return "datetimeHour";
  return "date";
}

/**
 * Query zone-level HTTP stats for a specific hostname. Returns null
 * when zone lookup fails or GraphQL errors out — caller should degrade
 * gracefully (AE-only numbers are still useful).
 */
export async function queryZoneHttpAnalytics(
  env: Env,
  hostname: string,
  periodHours: number,
  zoneName: string,
): Promise<ZoneHttpAnalytics | null> {
  const zoneId = await getZoneId(env, zoneName);
  if (!zoneId) return null;

  // CF GraphQL `httpRequestsAdaptiveGroups` has a per-plan time-range
  // cap. Free-tier zones cap at 1 day, so any query with a wider
  // window fails with a `quota` error. Skip the zone query entirely
  // for periods > 24h rather than 502-ing the whole metrics endpoint;
  // the caller falls back to AE-only totals (which cover full period
  // because tail events write to our own dataset, not CF's).
  if (periodHours > 24) return null;

  // Even for ≤ 24h, subtract a 60s safety buffer: we compute `since`
  // in JS then CF evaluates it against its own clock a few hundred
  // ms later, which pushes `now − since` just over 1 day and CF
  // rejects with "time range wider than 1d". 60s is well within
  // error-tolerance for "last 24 hours" observability.
  const since = new Date(
    Date.now() - periodHours * 60 * 60 * 1000 + 60_000,
  ).toISOString();
  const dim = bucketDimension(periodHours);
  const timeFilterKey = dim === "date" ? "date_geq" : "datetime_geq";
  const timeFilterValue = dim === "date" ? since.slice(0, 10) : since;

  const query = `
    query {
      viewer {
        zones(filter: { zoneTag: "${zoneId}" }) {
          totals: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              ${timeFilterKey}: "${timeFilterValue}"
            }
            limit: 1
          ) {
            count
          }
          cached: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              ${timeFilterKey}: "${timeFilterValue}"
              cacheStatus: "hit"
            }
            limit: 1
          ) {
            count
          }
          series: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              ${timeFilterKey}: "${timeFilterValue}"
            }
            limit: 1000
            orderBy: [${dim}_ASC]
          ) {
            dimensions { ${dim} }
            count
          }
          cachedSeries: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              ${timeFilterKey}: "${timeFilterValue}"
              cacheStatus: "hit"
            }
            limit: 1000
            orderBy: [${dim}_ASC]
          ) {
            dimensions { ${dim} }
            count
          }
          errors: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              ${timeFilterKey}: "${timeFilterValue}"
              edgeResponseStatus_gt: 499
            }
            limit: 1
          ) {
            count
          }
        }
      }
    }
  `;

  let json: {
    data?: {
      viewer?: {
        zones?: Array<{
          totals?: Array<{ count: number }>;
          cached?: Array<{ count: number }>;
          series?: Array<{
            dimensions: Record<string, string>;
            count: number;
          }>;
          cachedSeries?: Array<{
            dimensions: Record<string, string>;
            count: number;
          }>;
          errors?: Array<{ count: number }>;
        }>;
      };
    };
  };
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }

  // CF GraphQL returns HTTP 200 on permission/query errors — check the
  // `errors` array and log once per failing zone so wrangler tail makes
  // misconfig (e.g. token missing Zone Analytics:Read) diagnosable
  // without hand-instrumenting the route.
  const anyJson = json as unknown as { errors?: Array<{ message: string }> };
  if (anyJson.errors && anyJson.errors.length > 0) {
    console.log(
      "zone-analytics: graphql errors for",
      hostname,
      "/",
      zoneName,
      ":",
      JSON.stringify(anyJson.errors),
    );
    return null;
  }

  const zone = json.data?.viewer?.zones?.[0];
  if (!zone) return null;

  const totalCount = zone.totals?.[0]?.count ?? 0;
  const cachedCount = zone.cached?.[0]?.count ?? 0;
  const errs = zone.errors?.[0]?.count ?? 0;

  // Index cached series by bucket timestamp so we can line up with
  // the full series and compute cachedReqs per-bucket.
  const cachedByT = new Map<string, number>();
  for (const cs of zone.cachedSeries ?? []) {
    cachedByT.set(cs.dimensions[dim], cs.count);
  }
  const series: ZoneSeriesPoint[] = (zone.series ?? []).map((s) => {
    const key = s.dimensions[dim];
    return {
      t: Date.parse(key),
      reqs: s.count,
      cachedReqs: cachedByT.get(key) ?? 0,
    };
  });

  return {
    totals: {
      reqs: totalCount,
      cachedReqs: cachedCount,
      errs,
    },
    series,
  };
}

/**
 * Query zone analytics across multiple hostnames (e.g. a project's
 * default `{slug}-{team}.bycreek.com` plus any active custom domains)
 * and merge totals + series.
 *
 * Each hostname's zone is inferred from its last two labels. Hostnames
 * on zones we don't control (external user-owned domains) silently
 * return null from the per-hostname helper; remaining hostnames still
 * contribute. If every hostname fails, the merged result is null.
 *
 * Series merging: bucket timestamps are aligned (same `bucketDimension`
 * is used per periodHours across all hostnames), so we group by `t`
 * and sum requests + cachedRequests into a single series.
 */
export async function queryZoneHttpAnalyticsMerged(
  env: Env,
  hostnames: string[],
  periodHours: number,
): Promise<ZoneHttpAnalytics | null> {
  if (hostnames.length === 0) return null;

  const results = await Promise.all(
    hostnames.map((h) =>
      queryZoneHttpAnalytics(env, h, periodHours, extractZoneName(h)),
    ),
  );
  const ok = results.filter((r): r is ZoneHttpAnalytics => r !== null);
  if (ok.length === 0) return null;

  const totals: ZoneTotals = { reqs: 0, cachedReqs: 0, errs: 0 };
  for (const r of ok) {
    totals.reqs += r.totals.reqs;
    totals.cachedReqs += r.totals.cachedReqs;
    totals.errs += r.totals.errs;
  }

  const byT = new Map<number, ZoneSeriesPoint>();
  for (const r of ok) {
    for (const p of r.series) {
      const existing = byT.get(p.t);
      if (existing) {
        existing.reqs += p.reqs;
        existing.cachedReqs += p.cachedReqs;
      } else {
        byT.set(p.t, { t: p.t, reqs: p.reqs, cachedReqs: p.cachedReqs });
      }
    }
  }
  const series = [...byT.values()].sort((a, b) => a.t - b.t);

  return { totals, series };
}
