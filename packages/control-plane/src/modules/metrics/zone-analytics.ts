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

function bucketDimension(periodHours: number): string {
  if (periodHours <= 1) return "datetimeFiveMinutes";
  if (periodHours <= 24) return "datetimeFifteenMinutes";
  return "datetimeHour";
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

  const since = new Date(
    Date.now() - periodHours * 60 * 60 * 1000,
  ).toISOString();
  const dim = bucketDimension(periodHours);

  const query = `
    query {
      viewer {
        zones(filter: { zoneTag: "${zoneId}" }) {
          totals: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              datetime_gt: "${since}"
            }
            limit: 1
          ) {
            sum { requests, cachedRequests }
            count
          }
          series: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              datetime_gt: "${since}"
            }
            limit: 1000
            orderBy: [${dim}_ASC]
          ) {
            dimensions { ${dim} }
            sum { requests, cachedRequests }
          }
          errors: httpRequestsAdaptiveGroups(
            filter: {
              clientRequestHTTPHost: "${hostname}"
              datetime_gt: "${since}"
              edgeResponseStatus_gt: 499
            }
            limit: 1
          ) {
            sum { requests }
          }
        }
      }
    }
  `;

  let json: {
    data?: {
      viewer?: {
        zones?: Array<{
          totals?: Array<{ sum: { requests: number; cachedRequests: number } }>;
          series?: Array<{
            dimensions: Record<string, string>;
            sum: { requests: number; cachedRequests: number };
          }>;
          errors?: Array<{ sum: { requests: number } }>;
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

  const zone = json.data?.viewer?.zones?.[0];
  if (!zone) return null;

  const totals = zone.totals?.[0]?.sum ?? { requests: 0, cachedRequests: 0 };
  const errs = zone.errors?.[0]?.sum.requests ?? 0;

  const series: ZoneSeriesPoint[] = (zone.series ?? []).map((s) => ({
    t: Date.parse(s.dimensions[dim]),
    reqs: s.sum.requests,
    cachedReqs: s.sum.cachedRequests,
  }));

  return {
    totals: {
      reqs: totals.requests,
      cachedReqs: totals.cachedRequests,
      errs,
    },
    series,
  };
}
