/**
 * API response types.
 *
 * Routes return raw D1 rows (`SELECT *`), so each type must match its table's
 * actual column names. The DB is Drizzle and its columns are **camelCase**
 * (schema.ts / drizzle migrations: emailVerified, createdAt, organizationId,
 * failedStep, …) — NOT snake_case. `Deployment` below has been corrected to
 * match; a reader that assumes snake_case (failed_step, created_at, github_id)
 * silently gets `undefined`.
 *
 * ⚠️ The other interfaces here (User, Project, …) still declare snake_case that
 * does NOT match those camelCase columns and is stale in places (e.g. User has
 * no `github_id` column at all). They are wrong for the same reason and should
 * be audited + corrected the same way `Deployment` was — tracked as follow-up,
 * out of scope for this change. Do not copy their snake_case shape for new types.
 */

export interface User {
  id: string;
  email: string;
  github_id: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  slug: string;
  team_id: string;
  production_deployment_id: string | null;
  production_branch: string;
  framework: Framework | null;
  github_repo: string | null;
  created_at: string;
  updated_at: string;
}

// Field names are camelCase to match what the API actually returns: every
// deployments endpoint selects the raw D1 row (`SELECT * FROM deployment`) and
// the table columns are camelCase (see drizzle/0000_curvy_hulk.sql —
// failedStep, errorMessage, commitSha, …). The earlier snake_case shape was
// wrong, so readers of failed_step/error_message/commit_sha silently got
// undefined; keep this aligned with the DB to avoid that class of bug.
export interface Deployment {
  id: string;
  projectId: string;
  version: number;
  status: DeploymentStatus;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  triggerType: DeploymentTrigger;
  failedStep: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentVariable {
  project_id: string;
  key: string;
  encrypted_value: string;
}

export interface AuthToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export type DeploymentStatus =
  | "queued"
  | "uploading"
  | "provisioning"
  | "deploying"
  | "active"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type DeploymentTrigger = "cli" | "github" | "api" | "remote" | "rollback";

export type Framework =
  | "nextjs"
  | "tanstack-start"
  | "react-router"
  | "vite-react"
  | "vite-vue"
  | "vite-svelte"
  | "vite-solid"
  | "sveltekit"
  | "solidstart"
  | "nuxt"
  | "astro"
  | "vitepress";

export type RenderMode = "spa" | "ssr" | "worker";

export function isSSRFramework(framework: Framework | null): boolean {
  return (
    framework === "nextjs" ||
    framework === "tanstack-start" ||
    framework === "react-router" ||
    framework === "sveltekit" ||
    framework === "solidstart" ||
    framework === "nuxt"
  );
}

export interface DeploymentManifest {
  projectId: string;
  deploymentId: string;
  framework: Framework | null;
  renderMode: RenderMode;
  hasWorker: boolean;
  assets: string[];
  entrypoint: string | null;
}

export interface DeployBundle {
  manifest: DeploymentManifest;
  workerScript: string | null;
  assets: Map<string, Uint8Array>;
}

export interface CustomDomain {
  id: string;
  projectId: string;
  hostname: string;
  status: "pending" | "provisioning" | "active" | "failed";
  createdAt: number;
}

/** The DNS record a tenant must create to point a hostname at Creek. */
export interface DomainDnsInstruction {
  cname: { name: string; target: string };
}

/** A single custom domain plus its (always-retrievable) DNS instruction. */
export interface DomainDetail extends CustomDomain {
  dns: DomainDnsInstruction;
}

/**
 * Result of `activateDomain`. activate is honest: it only reports `active`
 * when the edge confirms the hostname. `pending_dns` means Creek is ready but
 * DNS isn't resolving yet; `manual` flags an activation with no edge to verify
 * against (self-hosted / zone not configured).
 */
export interface ActivateDomainResult {
  ok: boolean;
  status?: "active" | "pending_dns";
  message?: string;
  manual?: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface CreateProjectRequest {
  slug: string;
  framework?: Framework;
}

export interface CreateProjectResponse {
  project: Project;
}

export interface CreateDeploymentResponse {
  deployment: Deployment;
}

export interface DeploymentStatusResponse {
  deployment: Deployment;
  url: string | null;
  previewUrl: string;
  /**
   * Present only when `deployment.status === "failed"`. A stable, machine-
   * readable reason code (branch on it) plus a one-line actionable hint —
   * classified server-side from the recorded failure, since the activation
   * stage uploads no build log to read the reason from.
   */
  errorCode?: string;
  errorHint?: string;
}

// --- Logs (Phase 8 — mirrors control-plane/src/modules/logs/types.ts) ---

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

export interface LogQueryFilters {
  /** Relative ("1h", "30m", "2d") or ISO timestamp. */
  since?: string;
  /** "now" or ISO timestamp. */
  until?: string;
  outcomes?: LogEntry["outcome"][];
  scriptTypes?: LogEntry["scriptType"][];
  /** 8-hex deployId — implies scriptType=deployment. */
  deployment?: string;
  /** Branch name — implies scriptType=branch. */
  branch?: string;
  levels?: LogEntry["logs"][number]["level"][];
  /** Substring against console messages, exception messages, request URL. */
  search?: string;
  /** Max returned. Server clamps to 1000. */
  limit?: number;
}

export interface LogQueryResponse {
  entries: LogEntry[];
  truncated: boolean;
  query: { sinceMs: number; untilMs: number; limit: number };
}

/**
 * Shape of GET /projects/:slug/metrics?period=24h. Mirrors
 * packages/control-plane/src/modules/metrics/routes.ts. Zone-level
 * totals (including edge-cache hits) and AE-level invocation totals
 * are both surfaced so the caller can distinguish total traffic from
 * worker-executed traffic.
 */
export interface MetricsResponse {
  period: string;
  totals: {
    /** Total requests including edge cache hits (zone GraphQL). */
    reqs: number;
    /** Subset of reqs served from edge cache without invoking the worker. */
    cachedReqs: number;
    /** Worker invocations only (AE event count). */
    invocations: number;
    /** Errors from worker-level exceptions + 5xx (AE). */
    errs: number;
  };
  /** Time series bucketed by period — {t} is ms epoch. */
  series: Array<{ t: number; reqs: number; errs: number }>;
  /** Zone-level time series including cached traffic — null if zone query failed. */
  httpSeries: Array<{ t: number; reqs: number; cachedReqs: number }> | null;
  breakdowns: {
    method: Array<{ label: string; reqs: number; errs: number }>;
    scriptType: Array<{ label: string; reqs: number; errs: number }>;
    statusBucket: Array<{ label: string; reqs: number; errs: number }>;
  };
}
