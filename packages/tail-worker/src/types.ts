/**
 * Local type definitions for the Tail Worker contract.
 *
 * Cloudflare's @cloudflare/workers-types ships partial Tail Worker
 * types but they're shallow and rename frequently. We mirror only
 * the fields we read; if CF expands the schema, this stays compatible
 * because we only `pick` what we need.
 *
 * Cross-reference:
 *   https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/
 *   creek-observability-design.md (section "Tail Worker: creek-tail-worker")
 */

export type TailOutcome =
  | "ok"
  | "exception"
  | "exceededCpu"
  | "exceededMemory"
  | "canceled"
  | "responseStreamDisconnected"
  | "scriptNotFound"
  | "unknown";

export interface TailLog {
  level: "log" | "warn" | "error" | "info" | "debug";
  message: unknown[];
  timestamp: number;
}

export interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

export interface TailFetchEvent {
  request?: {
    url: string;
    method: string;
    /**
     * Sensitive headers (Authorization, Cookie, Set-Cookie, etc.) are
     * REDACTED by CF. We deliberately do NOT call getUnredacted() —
     * see "Privacy" section of creek-observability-design.md.
     */
    headers: Record<string, string>;
    cf?: Record<string, unknown>;
  };
  response?: { status: number };
}

export interface TailEvent {
  scriptName: string;
  outcome: TailOutcome;
  eventTimestamp: number;
  event: TailFetchEvent | null;
  logs: TailLog[];
  exceptions: TailException[];
}

/**
 * Structured log entry written to R2. One entry per producer
 * invocation. Schema is the contract for the future log query API
 * and `creek logs` CLI — bumping its shape is a breaking change.
 */
export interface LogEntry {
  /** Schema version. Bump when fields are removed or repurposed. */
  v: 1;
  /** ms epoch — when the producer Worker invocation occurred. */
  timestamp: number;
  team: string;
  project: string;
  /** Which deployment variant: prod / branch preview / deploy preview. */
  scriptType: "production" | "branch" | "deployment";
  /** Branch name (when scriptType === "branch"). */
  branch?: string;
  /** 8-hex deploy id (when scriptType === "deployment"). */
  deployId?: string;
  /** Producer Worker outcome. "ok" + exceptions=[] is a healthy request. */
  outcome: TailOutcome;
  request?: {
    url: string;
    method: string;
    status?: number;
  };
  /** console.log/warn/error/info/debug calls, in order. */
  logs: TailLog[];
  /** Uncaught exceptions thrown by the producer. */
  exceptions: TailException[];
}
