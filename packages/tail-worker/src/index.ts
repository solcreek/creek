/**
 * creek-tail — receives trace events from every tenant Worker via
 * Cloudflare's Tail Worker mechanism. Attached to user scripts via
 * the `tail_consumers` metadata field that deploy-core injects on
 * upload (per-script, not namespace-level — see Privacy + Dispatch
 * sections of creek-observability-design.md).
 *
 * Today: parses each event, drops non-tenant traces, writes the
 * structured log batch to R2 ndjson per (team, project, hour).
 * Future steps:
 *   - Step 3: also write Analytics Engine data points (metrics)
 *   - Step 4: also push to Realtime DO for `creek logs --follow`
 *
 * Best-effort: tail handler failures don't propagate back to the
 * producer Worker. Don't put audit-class data here — that goes
 * through control-plane's audit_log table.
 */

import { parseScriptName, type TeamInfo } from "./parse.js";
import { writeBatchToR2 } from "./r2-writer.js";
import type { LogEntry, TailEvent } from "./types.js";

interface Env {
  DB: D1Database;
  LOGS_BUCKET: R2Bucket;
  CREEK_DOMAIN: string;
  /**
   * TEMPORARY (Phase 8 verification only): allows GET /__inspect to
   * list R2 contents when called with this secret in `x-creek-inspect`.
   * Remove this handler + binding once Step 5 (control-plane log API)
   * lands and provides a properly authed read path.
   */
  INSPECT_SECRET?: string;
}

// --- Team cache ---
//
// Tail Worker fires once per producer invocation; reading the team
// list from D1 every time would dominate CPU. Cache for 5 min, same
// TTL the dispatch-worker uses for the same query. Stale teams just
// mean a few minutes of misclassified-as-null events for newly
// created orgs — acceptable for log routing.
let teamsCache: TeamInfo[] = [];
let teamsCacheTime = 0;
const TEAM_CACHE_TTL = 5 * 60 * 1000;

async function getTeams(db: D1Database): Promise<TeamInfo[]> {
  if (Date.now() - teamsCacheTime < TEAM_CACHE_TTL) return teamsCache;
  const rows = await db
    .prepare("SELECT slug, plan FROM organization ORDER BY length(slug) DESC")
    .all<TeamInfo>();
  teamsCache = rows.results;
  teamsCacheTime = Date.now();
  return teamsCache;
}

export default {
  // TEMPORARY (Phase 8 verification): see Env.INSPECT_SECRET.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/__inspect") return new Response("not found", { status: 404 });
    if (!env.INSPECT_SECRET || req.headers.get("x-creek-inspect") !== env.INSPECT_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const prefix = url.searchParams.get("prefix") ?? "logs/";
    const list = await env.LOGS_BUCKET.list({ prefix, limit: 50 });
    const objects = await Promise.all(
      list.objects.map(async (o) => {
        const obj = await env.LOGS_BUCKET.get(o.key);
        const body = obj ? await obj.text() : "";
        return { key: o.key, size: o.size, uploaded: o.uploaded, sample: body.slice(0, 500) };
      }),
    );
    return Response.json({ count: list.objects.length, truncated: list.truncated, objects });
  },

  async tail(events: TailEvent[], env: Env): Promise<void> {
    if (events.length === 0) return;

    const teams = await getTeams(env.DB);
    const entries: LogEntry[] = [];

    for (const event of events) {
      const parsed = parseScriptName(event.scriptName, teams);
      if (!parsed) continue; // platform script (dispatch, control-plane, etc.) — drop

      entries.push({
        v: 1,
        timestamp: event.eventTimestamp,
        team: parsed.team,
        project: parsed.project,
        scriptType: parsed.type,
        ...(parsed.branch ? { branch: parsed.branch } : {}),
        ...(parsed.deployId ? { deployId: parsed.deployId } : {}),
        outcome: event.outcome,
        ...(event.event?.request
          ? {
              request: {
                url: event.event.request.url,
                method: event.event.request.method,
                ...(event.event.response ? { status: event.event.response.status } : {}),
              },
            }
          : {}),
        logs: event.logs,
        exceptions: event.exceptions,
      });
    }

    if (entries.length === 0) return;

    await writeBatchToR2(env, entries);
  },
};
