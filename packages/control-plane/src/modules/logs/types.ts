/**
 * Schema mirror of tail-worker's LogEntry. We re-declare instead of
 * importing from @solcreek/tail-worker because (a) the worker isn't
 * a published package and (b) this side is read-only and shouldn't
 * pull in the writer's deps. If the schema changes there, bump
 * `v` AND update this file.
 */
export interface LogEntry {
  v: 1;
  timestamp: number;
  team: string;
  project: string;
  scriptType: "production" | "branch" | "deployment";
  branch?: string;
  deployId?: string;
  outcome:
    | "ok"
    | "exception"
    | "exceededCpu"
    | "exceededMemory"
    | "canceled"
    | "responseStreamDisconnected"
    | "scriptNotFound"
    | "unknown";
  request?: { url: string; method: string; status?: number };
  logs: Array<{
    level: "log" | "warn" | "error" | "info" | "debug";
    message: unknown[];
    timestamp: number;
  }>;
  exceptions: Array<{ name: string; message: string; timestamp: number }>;
}

export interface LogQuery {
  /** Inclusive lower bound, ms since epoch. */
  sinceMs: number;
  /** Inclusive upper bound, ms since epoch. */
  untilMs: number;
  /** Filter by tail outcome (any of). Empty = all. */
  outcomes: Set<LogEntry["outcome"]>;
  /** Filter by script variant. Empty = all. */
  scriptTypes: Set<LogEntry["scriptType"]>;
  /** Filter by deployment short id (8 hex). Implies scriptType=deployment. */
  deployId: string | null;
  /** Filter by branch name. Implies scriptType=branch. */
  branch: string | null;
  /** Keep entries whose `logs[]` includes at least one of these levels. Empty = all. */
  levels: Set<LogEntry["logs"][number]["level"]>;
  /** Substring match against any console message or exception message. Empty = no filter. */
  search: string;
  /** Max entries returned. Server clamps to 1000. */
  limit: number;
}
