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

export interface ListAppsResponse {
  apps: AppView[];
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

const DEFAULT_URL = "http://127.0.0.1:9080";

export function getCreekdUrl(): string {
  return process.env.CREEKD_URL || process.env.CREEKCTL_SERVER || DEFAULT_URL;
}

export function getCreekdToken(): string {
  return process.env.CREEKD_TOKEN || process.env.CREEKCTL_TOKEN || "";
}

export class CreekdClient {
  constructor(
    private baseUrl: string = getCreekdUrl(),
    private token: string = getCreekdToken(),
  ) {}

  async listApps(): Promise<AppView[]> {
    const resp = await this.get<ListAppsResponse>("/v1/apps");
    return resp.apps;
  }

  async getApp(id: string): Promise<AppView> {
    return this.get<AppView>(`/v1/apps/${encodeURIComponent(id)}`);
  }

  async getStats(id: string): Promise<StatsView> {
    return this.get<StatsView>(`/v1/apps/${encodeURIComponent(id)}/stats`);
  }

  async getAppLogs(id: string, tail = 100): Promise<string> {
    const res = await this.request("GET", `/v1/apps/${encodeURIComponent(id)}/logs?tail=${tail}`);
    return res.text();
  }

  async stopApp(id: string): Promise<void> {
    await this.request("DELETE", `/v1/apps/${encodeURIComponent(id)}`);
  }

  async restartApp(id: string): Promise<AppView> {
    return this.post<AppView>(`/v1/apps/${encodeURIComponent(id)}/restart`, {});
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request("GET", path);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request("POST", path, body);
    return res.json() as Promise<T>;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ code: "unknown", error: res.statusText })) as ErrorResponse;
      throw new CreekdApiError(res.status, err.code);
    }
    return res;
  }
}
