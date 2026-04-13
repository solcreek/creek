/**
 * Pure filter logic for `creek logs --follow`.
 *
 * Historical mode (`creek logs --since`) gets server-side filtering;
 * live mode (`--follow`) receives ALL log events for the project's
 * realtime room and must filter client-side. This module is the
 * mirror of control-plane/src/modules/logs/query.ts:matchesQuery —
 * if those drift, --follow shows different entries than --since
 * for the same flags.
 */

import type { LogEntry, LogQueryFilters } from "@solcreek/sdk";

export function matchesClientSide(
  entry: LogEntry,
  filters: LogQueryFilters,
): boolean {
  if (filters.outcomes?.length && !filters.outcomes.includes(entry.outcome)) return false;
  if (filters.scriptTypes?.length && !filters.scriptTypes.includes(entry.scriptType)) return false;
  if (filters.deployment && entry.deployId !== filters.deployment) return false;
  if (filters.branch && entry.branch !== filters.branch) return false;
  if (filters.levels?.length) {
    const hit = entry.logs.some((l) => filters.levels!.includes(l.level));
    if (!hit) return false;
  }
  if (filters.search) {
    if (!searchMatches(entry, filters.search)) return false;
  }
  return true;
}

function searchMatches(entry: LogEntry, needle: string): boolean {
  const n = needle.toLowerCase();
  const haystack =
    entry.logs
      .flatMap((l) => l.message.map((m) => (typeof m === "string" ? m : safeStringify(m))))
      .join(" ") +
    " " +
    entry.exceptions.map((e) => `${e.name} ${e.message}`).join(" ") +
    " " +
    (entry.request?.url ?? "");
  return haystack.toLowerCase().includes(n);
}

export function describeFilters(filters: LogQueryFilters): string {
  const bits: string[] = [];
  if (filters.outcomes?.length) bits.push(`outcome=${filters.outcomes.join(",")}`);
  if (filters.scriptTypes?.length) bits.push(`scriptType=${filters.scriptTypes.join(",")}`);
  if (filters.deployment) bits.push(`deployment=${filters.deployment}`);
  if (filters.branch) bits.push(`branch=${filters.branch}`);
  if (filters.levels?.length) bits.push(`level=${filters.levels.join(",")}`);
  if (filters.search) bits.push(`search="${filters.search}"`);
  return bits.length === 0 ? "(none)" : bits.join(" ");
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
