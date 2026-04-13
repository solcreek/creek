/**
 * Pure query parsing + entry filtering.
 *
 * Two responsibilities:
 *   1. parseQuery() — turn URLSearchParams into a typed LogQuery.
 *      Defensive: bad input falls back to defaults rather than 400-ing,
 *      because logs UIs benefit from graceful degradation.
 *   2. matchesQuery() — predicate over LogEntry. Stays pure so tests
 *      can drive it with a table.
 *
 * Time inputs accept either an ISO timestamp ("2026-04-13T18:00:00Z")
 * or a relative duration ("1h", "30m", "2d"). Resolved against `now`
 * (caller passes Date.now() so tests can pin time).
 */

import type { LogEntry, LogQuery } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_SINCE_MS = 60 * 60 * 1000; // 1h
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const VALID_OUTCOMES = new Set<LogEntry["outcome"]>([
  "ok",
  "exception",
  "exceededCpu",
  "exceededMemory",
  "canceled",
  "responseStreamDisconnected",
  "scriptNotFound",
  "unknown",
]);

const VALID_SCRIPT_TYPES = new Set<LogEntry["scriptType"]>([
  "production",
  "branch",
  "deployment",
]);

const VALID_LEVELS = new Set<LogEntry["logs"][number]["level"]>([
  "log",
  "warn",
  "error",
  "info",
  "debug",
]);

export function parseQuery(params: URLSearchParams, now: number): LogQuery {
  const untilMs = parseTimeOrNow(params.get("until"), now);
  let sinceMs = parseTime(params.get("since"), now) ?? untilMs - DEFAULT_SINCE_MS;
  if (sinceMs >= untilMs) sinceMs = untilMs - DEFAULT_SINCE_MS;
  // Clamp range — protects R2 cost from a `?since=10y` query.
  if (untilMs - sinceMs > MAX_RANGE_MS) sinceMs = untilMs - MAX_RANGE_MS;

  return {
    sinceMs,
    untilMs,
    outcomes: pickSet(params.getAll("outcome"), VALID_OUTCOMES),
    scriptTypes: pickSet(params.getAll("scriptType"), VALID_SCRIPT_TYPES),
    deployId: params.get("deployment"),
    branch: params.get("branch"),
    levels: pickSet(params.getAll("level"), VALID_LEVELS),
    search: (params.get("search") ?? "").trim(),
    limit: clampLimit(params.get("limit")),
  };
}

export function matchesQuery(entry: LogEntry, q: LogQuery): boolean {
  if (entry.timestamp < q.sinceMs || entry.timestamp > q.untilMs) return false;
  if (q.outcomes.size > 0 && !q.outcomes.has(entry.outcome)) return false;
  if (q.scriptTypes.size > 0 && !q.scriptTypes.has(entry.scriptType)) return false;
  if (q.deployId !== null && entry.deployId !== q.deployId) return false;
  if (q.branch !== null && entry.branch !== q.branch) return false;
  if (q.levels.size > 0) {
    const hit = entry.logs.some((l) => q.levels.has(l.level));
    if (!hit) return false;
  }
  if (q.search) {
    if (!entryMatchesSearch(entry, q.search)) return false;
  }
  return true;
}

function entryMatchesSearch(entry: LogEntry, needle: string): boolean {
  const n = needle.toLowerCase();
  for (const log of entry.logs) {
    for (const m of log.message) {
      const s = typeof m === "string" ? m : safeStringify(m);
      if (s.toLowerCase().includes(n)) return true;
    }
  }
  for (const ex of entry.exceptions) {
    if (ex.message.toLowerCase().includes(n)) return true;
    if (ex.name.toLowerCase().includes(n)) return true;
  }
  if (entry.request?.url.toLowerCase().includes(n)) return true;
  return false;
}

function parseTime(input: string | null, now: number): number | null {
  if (!input) return null;
  // Relative: "1h", "30m", "2d", "10s"
  const rel = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "s" ? n * 1000
             : unit === "m" ? n * 60_000
             : unit === "h" ? n * 3_600_000
             :                n * 86_400_000;
    return now - ms;
  }
  // ISO timestamp
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : null;
}

function parseTimeOrNow(input: string | null, now: number): number {
  if (!input || input === "now") return now;
  return parseTime(input, now) ?? now;
}

function pickSet<T extends string>(
  values: string[],
  valid: Set<T>,
): Set<T> {
  const out = new Set<T>();
  for (const v of values) {
    if (valid.has(v as T)) out.add(v as T);
  }
  return out;
}

function clampLimit(input: string | null): number {
  const n = input ? Number(input) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
