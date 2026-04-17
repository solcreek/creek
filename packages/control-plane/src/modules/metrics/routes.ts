/**
 * Metrics routes — read `creek_tenant_requests` AE dataset, scoped to
 * the authenticated team's projects. Parallel to logs routes:
 *
 *   GET /projects/:slug/metrics?period=24h
 *
 * Returns totals + time-series + three categorical breakdowns in one
 * response so the Dashboard can render the full tab with a single
 * round-trip. AE costs are tiny (SUMs over columnar rows) and CF
 * CDN-caches the SQL response briefly — one endpoint stays cheap.
 *
 * Tenant isolation: teamSlug comes from c.get("teamSlug") (signed
 * session via tenantMiddleware), NEVER from URL/query. The project
 * slug is verified against (project.slug, project.organizationId)
 * before any AE call. The AE WHERE clause uses quote()-escaped slugs.
 */

import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import { requirePermission } from "../tenant/permissions.js";
import { querySql } from "./ae-sql.js";
import {
  totalsSql,
  timeseriesSql,
  breakdownSql,
  type BreakdownDimension,
} from "./queries.js";
import { queryZoneHttpAnalyticsMerged } from "./zone-analytics.js";

type MetricsEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string };
};

export const metrics = new Hono<MetricsEnv>();

const PERIOD_HOURS: Record<string, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

metrics.get(
  "/:slug/metrics",
  requirePermission("project:read"),
  async (c) => {
    const projectSlug = c.req.param("slug") ?? "";
    const teamSlug = c.get("teamSlug");
    const teamId = c.get("teamId");
    if (!projectSlug) {
      return c.json({ error: "validation", message: "slug required" }, 400);
    }

    const project = await c.env.DB.prepare(
      "SELECT id, slug FROM project WHERE slug = ? AND organizationId = ?",
    )
      .bind(projectSlug, teamId)
      .first<{ id: string; slug: string }>();
    if (!project) {
      return c.json(
        { error: "not_found", message: "Project not found in this team" },
        404,
      );
    }

    // Active custom domains — each may be on a different CF zone.
    // Zone analytics is queried per-hostname and results are merged so
    // a project with `www.creek.dev` + `creeksite.com` sees true
    // visitor counts instead of only its default bycreek.com hostname.
    const customDomainRows = await c.env.DB.prepare(
      "SELECT hostname FROM custom_domain WHERE projectId = ? AND status = 'active'",
    )
      .bind(project.id)
      .all<{ hostname: string }>();
    const customHostnames = (customDomainRows.results ?? []).map(
      (r) => r.hostname,
    );

    if (!c.env.CLOUDFLARE_API_TOKEN || !c.env.CLOUDFLARE_ACCOUNT_ID) {
      return c.json(
        { error: "metrics_unavailable", message: "AE credentials missing" },
        503,
      );
    }

    const periodKey = c.req.query("period") ?? "24h";
    const periodHours = PERIOD_HOURS[periodKey] ?? PERIOD_HOURS["24h"];
    const scope = {
      team: teamSlug,
      project: projectSlug,
      periodHours,
    };
    const dimensions: BreakdownDimension[] = [
      "method",
      "scriptType",
      "statusBucket",
    ];

    // Production hostname — what real visitors hit on the default
    // bycreek.com zone. Zone analytics covers edge-cached HTML that
    // AE (worker invocation events) can't see. We also merge in zone
    // data for every active custom domain so projects like apps.www
    // with a custom creek.dev hostname see true visitor counts.
    const prodHostname = `${projectSlug}-${teamSlug}.${c.env.CREEK_DOMAIN}`;
    const allHostnames = [prodHostname, ...customHostnames];

    try {
      const [totals, series, zone, ...breakdowns] = await Promise.all([
        querySql<{ reqs: number | null; errs: number | null }>(
          c.env,
          totalsSql(scope),
        ),
        querySql<{ bucket: number; reqs: number; errs: number }>(
          c.env,
          timeseriesSql(scope),
        ),
        queryZoneHttpAnalyticsMerged(c.env, allHostnames, periodHours),
        ...dimensions.map((d) =>
          querySql<{ label: string; reqs: number; errs: number }>(
            c.env,
            breakdownSql(scope, d),
          ),
        ),
      ]);

      const aeReqs = totals.data[0]?.reqs ?? 0;
      const aeErrs = totals.data[0]?.errs ?? 0;

      return c.json({
        period: periodKey,
        totals: {
          // Prefer zone-level request count when available — includes
          // edge-cached HTML that never invokes the worker. Fall back
          // to AE invocation count when the zone lookup fails.
          reqs: zone?.totals.reqs ?? aeReqs,
          cachedReqs: zone?.totals.cachedReqs ?? 0,
          // Invocations = what actually ran on the worker. Useful for
          // cost mental model vs raw traffic volume.
          invocations: aeReqs,
          // Errors from AE (worker-level exceptions + 5xx). Zone edge
          // 5xx would also be visible via zone.totals.errs but we keep
          // the authoritative error source on the invocation side.
          errs: aeErrs,
        },
        series: series.data.map((row) => ({
          // AE returns `bucket` as a UNIX second boundary. Convert to ms
          // for the UI side so a plain Date(ms) works without surprises.
          t: row.bucket * 1000,
          reqs: row.reqs,
          errs: row.errs,
        })),
        // Zone-level time-series when available — UI can stack
        // cached vs uncached so users see real traffic shape.
        httpSeries: zone?.series ?? null,
        breakdowns: {
          method: breakdowns[0].data,
          scriptType: breakdowns[1].data,
          statusBucket: breakdowns[2].data,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never leak AE SQL query bodies to clients — just the shape.
      return c.json(
        { error: "metrics_query_failed", message: msg.slice(0, 200) },
        502,
      );
    }
  },
);
