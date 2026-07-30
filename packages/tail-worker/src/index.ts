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
import { writeBatchToR2, writePlatformBatchToR2 } from "./r2-writer.js";
import { writeBatchToAnalytics } from "./analytics.js";
import { pushBatchToRealtime } from "./realtime.js";
import type { LogEntry, PlatformLogEntry, TailEvent } from "./types.js";

interface Env {
  DB: D1Database;
  LOGS_BUCKET: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  CREEK_DOMAIN: string;
  /** Optional realtime push (for `creek logs --follow`). Skipped when unset. */
  REALTIME_URL?: string;
  REALTIME_MASTER_KEY?: string;
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

/**
 * Should a platform (non-tenant) trace be kept?
 *
 * Healthy platform traffic is dropped — creek-dispatch alone sees every
 * request on the platform, so retaining it would dwarf tenant log volume
 * and tells us nothing. An uncaught exception is the opposite: it is
 * rendered to a visitor as a full-page Error 1101, and until now it was
 * the one trace we threw away. On 2026-07-30 a tenant reported a 1101 Ray
 * ID that could not be found anywhere in `creek logs` — because the
 * invocation that threw was creek-dispatch's own, and it was dropped here
 * before ever reaching R2.
 *
 * `canceled` is excluded on purpose: browsers abort in-flight RSC
 * prefetches constantly, and those carry no exception. We keep the traces
 * that recorded a throw.
 */
function isRetainablePlatformTrace(event: TailEvent): boolean {
  return event.exceptions.length > 0 || event.outcome === "exception";
}

function toPlatformEntry(event: TailEvent): PlatformLogEntry {
  return {
    v: 1,
    timestamp: event.eventTimestamp,
    script: event.scriptName,
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
  };
}

export default {
  async tail(events: TailEvent[], env: Env): Promise<void> {
    if (events.length === 0) return;

    const teams = await getTeams(env.DB);
    const entries: LogEntry[] = [];
    const platformEntries: PlatformLogEntry[] = [];

    for (const event of events) {
      const parsed = parseScriptName(event.scriptName, teams);
      if (!parsed) {
        // Platform script (dispatch, control-plane, etc.). Dropped unless
        // it threw — see isRetainablePlatformTrace.
        if (isRetainablePlatformTrace(event)) platformEntries.push(toPlatformEntry(event));
        continue;
      }

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

    if (entries.length === 0 && platformEntries.length === 0) return;

    // Three destinations for tenant entries:
    //   1. AE — sync, fire-and-forget; metrics survive R2 failures.
    //   2. R2 — durable history; awaited because it's the source of
    //      truth for `creek logs --since`.
    //   3. Realtime DO — best-effort push for `creek logs --follow`.
    //      Failures don't fail the tail handler; subscribers are
    //      expected to resync from R2 if they need a complete trace.
    //
    // Platform entries go to R2 only: they have no tenant tuple, so they
    // would blur AE's per-team metrics dimensions and have no `creek logs
    // --follow` subscriber to reach.
    writeBatchToAnalytics(env, entries);
    await Promise.allSettled([
      writeBatchToR2(env, entries),
      writePlatformBatchToR2(env, platformEntries),
      pushBatchToRealtime(env, entries),
    ]);
  },
};
