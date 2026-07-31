/**
 * "Did this request go wrong?" — the canonical predicate.
 *
 * This is a DERIVED notion, deliberately broader than `outcome`. A
 * request can complete with `outcome: "ok"` and still have failed the
 * visitor: an exception thrown after the response started streaming, or
 * a 5xx the worker returned on purpose. `outcome` alone sees neither.
 *
 * Why it exists as shared code (reported 2026-07-30):
 *
 * `creek metrics` counts errors with this rule — tail-worker stamps it
 * into the Analytics Engine `double2` column, which the metrics SQL sums
 * as `errs`. But `creek logs --outcome exception` filtered on the raw
 * `outcome` field alone. A tenant saw "40 errors" in metrics and got an
 * empty list from logs, because their failing entries were
 * `outcome: "ok"` with a `Network connection lost.` exception. They had
 * to dump everything and grep it themselves.
 *
 * The gap was not a broken filter — it was a MISSING one. `--outcome` is
 * modelled on Cloudflare's TailOutcome enum and answers a different,
 * narrower question. So `--errors` exists alongside it rather than
 * changing what `--outcome` means, and both are backed by this function.
 *
 * `outcome` itself is never rewritten to paper over the difference: it is
 * Cloudflare's fact, passed through verbatim, and "responded fine then
 * threw" is genuinely distinct from "the invocation failed".
 *
 * ⚠️ tail-worker keeps its own copy (`src/analytics.ts`) because it has
 * no dependencies and cannot import this package. That copy is the WRITE
 * side — it decides the AE column this predicate is meant to agree with.
 * Change one, change the other, or `creek metrics` and `creek logs
 * --errors` will disagree again.
 */

import type { LogEntry } from "../types/index.js";

/** Minimal shape the predicate needs — accepts any LogEntry mirror. */
export interface ErrorClassifiable {
  outcome: LogEntry["outcome"];
  request?: { status?: number };
  exceptions: unknown[];
}

export function isError(entry: ErrorClassifiable): boolean {
  if (entry.outcome !== "ok") return true;
  if (entry.exceptions.length > 0) return true;
  if (entry.request?.status !== undefined && entry.request.status >= 500) return true;
  return false;
}
