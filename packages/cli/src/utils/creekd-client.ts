/**
 * Lightweight creekd admin API client for the CLI.
 *
 * Uses plain fetch (no openapi-fetch dep) with types matching
 * the OpenAPI spec. The CLI only needs a handful of endpoints.
 */

export interface AppView {
  id: string;
  runtime?: string;
  command: string;
  args?: string[];
  env?: string[];
  port: number;
  status: "starting" | "running" | "crash_loop" | "stopping" | "stopped";
  pid: number;
  uptime_ms: number;
  restart_count: number;
  health_failures: number;
  net_ip?: string;
}

export interface StatsView {
  id: string;
  cgroup_enabled: boolean;
  memory_current_bytes?: number;
  memory_max_bytes?: number;
  pids_current?: number;
  cpu_usage_usec?: number;
  oom_kills?: number;
  read_err?: string;
}

export interface AppEnvelope {
  apiVersion: string;
  kind: string;
  metadata: { name: string; uid: string; generation: number; resourceVersion: string; creationTimestamp: string };
  spec: { runtime?: string; command?: string; args?: string[]; env?: string[]; port?: number };
  status: {
    observedGeneration: number;
    conditions: Array<{ type: string; status: string; lastTransitionTime: string; reason: string; message?: string }>;
    currentPid: number;
    currentPort: number;
    restartCount: number;
    healthFailures: number;
    uptimeMs: number;
  };
}

export interface ListAppsResponse {
  apps: AppView[];
}

/** Release ledger entry returned by POST /v1/apps/{id}/rollback. */
export interface Release {
  uid: string;
  phase: "Active" | "Superseded" | "RolledBack";
  creationTimestamp: string;
  spec: {
    appUid: string;
    releaseSeq: number;
    gitSha?: string;
    image?: string;
    envHash?: string;
    createdBy?: string;
    rolledBackFrom?: number;
    originalArtifactRelease?: number;
  };
}

export interface ErrorResponse {
  code: string;
  error: string;
}

export class CreekdApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`creekd: ${code} (${status})`);
    this.name = "CreekdApiError";
  }
}

/**
 * Thrown specifically on 412 Precondition Failed (If-Match
 * mismatch). Carries the daemon's CURRENT rv so the caller can
 * decide between (a) prompting the user to refresh, (b) auto-
 * retrying with the fresh rv when --bypass-rv was passed, or
 * (c) emitting a structured machine-readable error to JSON mode.
 *
 * Per DESIGN-self-host-state.md §"First-party CLI MUST send
 * If-Match": "On 412, CLI surfaces a structured prompt and does
 * NOT auto-retry by default."
 */
export class CreekdResourceVersionMismatchError extends CreekdApiError {
  constructor(
    public currentResourceVersion: string,
    public attemptedResourceVersion: string,
  ) {
    super(412, "resource_version_mismatch");
    this.name = "CreekdResourceVersionMismatchError";
    this.message = `creekd: resource_version_mismatch (current=${currentResourceVersion}, attempted=${attemptedResourceVersion})`;
  }
}

/** Options that apply to every mutating call. */
export interface MutateOptions {
  /**
   * If-Match value to send as the precondition header. Daemon
   * returns 412 → CreekdResourceVersionMismatchError if it doesn't
   * match the daemon's current rv. Omit (or pass undefined) for
   * unconditional writes; the daemon then attaches
   * `Warning: 299 - "unconditional-write"` to the response.
   */
  ifMatch?: string;
}

const DEFAULT_URL = "http://127.0.0.1:9080";

export function getCreekdUrl(): string {
  return process.env.CREEKD_URL || process.env.CREEKCTL_SERVER || DEFAULT_URL;
}

export function getCreekdToken(): string {
  return process.env.CREEKD_TOKEN || process.env.CREEKCTL_TOKEN || "";
}

export class CreekdClient {
  private baseUrl: string;
  constructor(
    baseUrl: string = getCreekdUrl(),
    private token: string = getCreekdToken(),
  ) {
    // Normalise: add http:// for bare host:port. Mirrors
    // utils/hostkey.ts's normalizeAdminAddr so the two callers
    // accept the same shape from hosts.json.
    if (!/^https?:\/\//.test(baseUrl)) {
      baseUrl = "http://" + baseUrl;
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async listApps(): Promise<AppView[]> {
    const resp = await this.get<ListAppsResponse>("/v1/apps");
    return resp.apps;
  }

  async getApp(id: string): Promise<AppEnvelope> {
    return this.get<AppEnvelope>(`/v1/apps/${encodeURIComponent(id)}`);
  }

  async getStats(id: string): Promise<StatsView> {
    return this.get<StatsView>(`/v1/apps/${encodeURIComponent(id)}/stats`);
  }

  async getAppLogs(id: string, tail = 100): Promise<string> {
    const res = await this.request("GET", `/v1/apps/${encodeURIComponent(id)}/logs?tail=${tail}`);
    return res.text();
  }

  async stopApp(id: string, opts: MutateOptions = {}): Promise<void> {
    await this.request("DELETE", `/v1/apps/${encodeURIComponent(id)}`, undefined, opts.ifMatch);
  }

  /**
   * Spawn a brand-new app. POST /v1/apps. Creation is not
   * spec-mutating in the rv sense — there's no prior version to
   * If-Match against — so ifMatch is intentionally NOT a parameter.
   */
  async spawnApp(body: unknown): Promise<AppView> {
    return this.post<AppView>(`/v1/apps`, body);
  }

  /**
   * Blue-green deploy of an existing app. POST /v1/apps/{id}/deploy.
   * Spec-mutating; pass ifMatch sourced from the local cache (or a
   * fresh getApp) — 412 surfaces as CreekdResourceVersionMismatchError.
   */
  async deployApp(id: string, body: unknown, opts: MutateOptions = {}): Promise<AppView> {
    const res = await this.request("POST", `/v1/apps/${encodeURIComponent(id)}/deploy`, body, opts.ifMatch);
    return res.json() as Promise<AppView>;
  }

  async restartApp(id: string): Promise<AppView> {
    // Restart is an OPERATION, not a spec mutation per
    // DESIGN-self-host-state.md §"Mutex granularity" — supervisor
    // restarts an existing app in place, neither generation nor rv
    // bumps. No If-Match needed.
    return this.post<AppView>(`/v1/apps/${encodeURIComponent(id)}/restart`, {});
  }

  /**
   * Roll back to the target release seq. Spec-mutating — accepts
   * If-Match. Throws CreekdResourceVersionMismatchError on 412.
   */
  async rollbackApp(id: string, toSeq: number, opts: MutateOptions = {}): Promise<Release> {
    const path = `/v1/apps/${encodeURIComponent(id)}/rollback?to=${toSeq}`;
    const res = await this.request("POST", path, undefined, opts.ifMatch);
    return res.json() as Promise<Release>;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request("GET", path);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request("POST", path, body);
    return res.json() as Promise<T>;
  }

  private async request(method: string, path: string, body?: unknown, ifMatch?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (ifMatch !== undefined) headers["If-Match"] = ifMatch;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ code: "unknown", error: res.statusText })) as ErrorResponse & {
        currentResourceVersion?: string;
      };
      // 412 carries the daemon's current rv in the body so the
      // caller can decide whether to refresh + retry. Surface as
      // the typed subclass — generic error handlers still catch it
      // via instanceof CreekdApiError.
      if (res.status === 412 && err.code === "resource_version_mismatch") {
        throw new CreekdResourceVersionMismatchError(
          err.currentResourceVersion ?? "",
          ifMatch ?? "",
        );
      }
      throw new CreekdApiError(res.status, err.code);
    }
    return res;
  }
}
