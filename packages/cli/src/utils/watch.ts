/**
 * Poll `GET /v1/apps/{id}` until the app reaches a terminal
 * deploy state: Ready=True + Progressing=False (success), or
 * Degraded=True reason=DeployTimeout (the daemon's own
 * progressing_timeout has flipped — surfaces here as
 * deploy_stuck per DESIGN-self-host-state.md §"progressing_timeout
 * uses monotonic clock"), or the client-side watch budget runs
 * out.
 *
 * This is the consumer of #10's observedGeneration / conditions
 * machinery and #8a's status.conditions[] surface. The whole
 * point of those server-side primitives is exactly THIS loop:
 * a watcher polling GET, inspecting conditions[], deciding
 * "still progressing vs converged vs stuck" without needing a
 * separate event stream.
 *
 * `watchDeploy` is pure (modulo fetch + setTimeout) — the
 * test harness drives it through synthetic state transitions
 * by sequencing mock responses.
 */

import type { CreekdClient, AppEnvelope } from "./creekd-client.js";

/** Terminal outcome of a watch loop. */
export type WatchResult =
  | { ok: true; reason: "ready"; envelope: AppEnvelope }
  | { ok: false; reason: "deploy_stuck"; envelope: AppEnvelope }
  | { ok: false; reason: "watch_timeout"; elapsedMs: number; lastEnvelope?: AppEnvelope }
  | { ok: false; reason: "fetch_failed"; error: Error };

export interface WatchOptions {
  /** Milliseconds between polls. Default 1000. Clamped to >=100. */
  pollIntervalMs?: number;
  /**
   * Maximum total wall time the watch will hang before returning
   * watch_timeout. Default 5 min. Independent of the daemon's
   * progressing_timeout — the client's bound is "user's patience"
   * not "server's deploy budget"; the two normally agree.
   */
  timeoutMs?: number;
  /**
   * Injected clock + sleep for tests. Production callers omit; the
   * defaults are Date.now + setTimeout-based delay.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional progress callback invoked after each poll. Tests use
   * this to assert intermediate state; production callers can
   * stream it to a spinner.
   */
  onPoll?: (envelope: AppEnvelope, elapsedMs: number) => void;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_POLL_MS = 100;

export async function watchDeploy(
  client: CreekdClient,
  appId: string,
  opts: WatchOptions = {},
): Promise<WatchResult> {
  const pollMs = Math.max(MIN_POLL_MS, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const start = now();
  let lastEnvelope: AppEnvelope | undefined;
  while (true) {
    const elapsedMs = now() - start;
    if (elapsedMs > timeoutMs) {
      return { ok: false, reason: "watch_timeout", elapsedMs, lastEnvelope };
    }
    let envelope: AppEnvelope;
    try {
      envelope = await client.getApp(appId);
    } catch (e) {
      return {
        ok: false,
        reason: "fetch_failed",
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
    lastEnvelope = envelope;
    opts.onPoll?.(envelope, elapsedMs);

    const verdict = classifyConditions(envelope);
    if (verdict === "ready") return { ok: true, reason: "ready", envelope };
    if (verdict === "deploy_stuck") return { ok: false, reason: "deploy_stuck", envelope };

    // "progressing" or "unknown" → keep polling.
    await sleep(pollMs);
  }
}

type Verdict = "ready" | "deploy_stuck" | "progressing" | "unknown";

/**
 * Inspect a single envelope's status.conditions[] and decide
 * whether the watch loop is done.
 *
 *   Ready=True AND Progressing=False     → ready (success)
 *   Degraded=True AND reason=DeployTimeout → deploy_stuck (DESIGN code)
 *   Progressing=True (any reason)         → progressing (keep polling)
 *   anything else                         → unknown (keep polling — server
 *                                                    hasn't classified yet)
 *
 * Exported for unit-test visibility; not part of the consumer
 * API.
 */
export function classifyConditions(envelope: AppEnvelope): Verdict {
  const conds = envelope.status?.conditions ?? [];
  const ready = conds.find((c) => c.type === "Ready");
  const progressing = conds.find((c) => c.type === "Progressing");
  const degraded = conds.find((c) => c.type === "Degraded");

  // deploy_stuck has highest priority — even if Ready=True somehow,
  // a DeployTimeout-flagged Degraded means the daemon gave up on
  // this generation's convergence and the client should report
  // failure rather than racing the wire.
  if (degraded?.status === "True" && degraded.reason === "DeployTimeout") {
    return "deploy_stuck";
  }
  if (ready?.status === "True" && progressing?.status === "False") {
    return "ready";
  }
  if (progressing?.status === "True") {
    return "progressing";
  }
  return "unknown";
}
