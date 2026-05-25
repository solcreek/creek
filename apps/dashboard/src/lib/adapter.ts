import { api } from "./api";
import type { AppView, App, Condition, StatsView } from "./creekd-client";

// --- Mode detection ---

export type ApiMode = "hosted" | "creekd";

export function detectApiMode(): ApiMode {
  const mode = import.meta.env.VITE_API_MODE;
  if (mode === "creekd") return "creekd";
  if (mode === "hosted") return "hosted";

  const url = import.meta.env.VITE_API_URL || "";
  if (url.includes("localhost:9080") || url.includes("127.0.0.1:9080")) {
    return "creekd";
  }
  return "hosted";
}

const MODE = detectApiMode();

// --- creekd plain fetch client ---

const CREEKD_BASE = import.meta.env.VITE_API_URL || (typeof window !== "undefined" ? window.location.origin : "");
const CREEKD_TOKEN = import.meta.env.VITE_CREEKD_TOKEN || "";

async function creekdFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (CREEKD_TOKEN) headers["Authorization"] = `Bearer ${CREEKD_TOKEN}`;
  if (options?.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${CREEKD_BASE}${path}`, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string>) } });
  } catch {
    throw new Error("Cannot connect to creekd");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        const body = JSON.parse(text);
        throw new Error(body.error || `creekd: ${res.status}`);
      } catch (e) {
        if (e instanceof Error && e.message !== text) throw e;
      }
    }
    throw new Error(`Cannot connect to creekd (${res.status})`);
  }

  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

// --- Unified API ---

interface ListAppsResponse { apps: AppView[] }

export async function listApps(): Promise<AppView[]> {
  if (MODE === "creekd") {
    const resp = await creekdFetch<ListAppsResponse>("/v1/apps");
    return resp.apps ?? [];
  }
  const projects = await api<Array<{ id: string; slug: string; framework: string | null; productionDeploymentId: string | null }>>("/projects");
  return projects.map((p) => ({
    id: p.id,
    command: "",
    port: 0,
    status: (p.productionDeploymentId ? "running" : "stopped") as AppView["status"],
    pid: 0,
    uptime_ms: 0,
    restart_count: 0,
    health_failures: 0,
    runtime: p.framework ?? undefined,
  }));
}

export interface AppDetail extends AppView {
  conditions: Condition[];
  resourceVersion?: string;
  generation?: number;
}

export async function getApp(id: string): Promise<AppDetail> {
  if (MODE === "creekd") {
    const envelope = await creekdFetch<App>(`/v1/apps/${encodeURIComponent(id)}`);
    return {
      ...envelopeToView(envelope),
      conditions: (envelope.status?.conditions as Condition[]) ?? [],
      resourceVersion: envelope.metadata?.resourceVersion,
      generation: envelope.metadata?.generation,
    };
  }
  const p = await api<{ id: string; slug: string; framework: string | null; productionDeploymentId: string | null }>(`/projects/${id}`);
  return {
    id: p.id,
    command: "",
    port: 0,
    status: (p.productionDeploymentId ? "running" : "stopped") as AppView["status"],
    pid: 0,
    uptime_ms: 0,
    restart_count: 0,
    health_failures: 0,
    runtime: p.framework ?? undefined,
    conditions: [],
  };
}

export async function getAppStats(id: string): Promise<StatsView> {
  if (MODE === "creekd") {
    return creekdFetch<StatsView>(`/v1/apps/${encodeURIComponent(id)}/stats`);
  }
  return { id, cgroup_enabled: false };
}

export async function getAppLogs(id: string, tail = 100): Promise<string> {
  if (MODE === "creekd") {
    let res: Response;
    try {
      const headers: Record<string, string> = {};
      if (CREEKD_TOKEN) headers["Authorization"] = `Bearer ${CREEKD_TOKEN}`;
      res = await fetch(`${CREEKD_BASE}/v1/apps/${encodeURIComponent(id)}/logs?tail=${tail}`, { headers });
    } catch {
      throw new Error("Cannot connect to creekd");
    }
    if (!res.ok) throw new Error(`Cannot connect to creekd (${res.status})`);
    return res.text();
  }
  const data = await api<{ lines: string[] }>(`/projects/${id}/logs`);
  return data.lines.join("\n");
}

export async function stopApp(id: string): Promise<void> {
  if (MODE === "creekd") {
    await creekdFetch(`/v1/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
    return;
  }
  await api(`/projects/${id}`, { method: "DELETE" });
}

export async function restartApp(id: string): Promise<AppView> {
  if (MODE === "creekd") {
    return creekdFetch<AppView>(`/v1/apps/${encodeURIComponent(id)}/restart`, {
      method: "POST",
      body: "{}",
    });
  }
  await api(`/projects/${id}/restart`, { method: "POST" });
  return getApp(id);
}

function envelopeToView(app: App): AppView {
  const ready = app.status?.conditions?.find((c: any) => c.type === "Ready");
  const progressing = app.status?.conditions?.find((c: any) => c.type === "Progressing");
  const degraded = app.status?.conditions?.find((c: any) => c.type === "Degraded");

  let status: AppView["status"] = "stopped";
  if (degraded?.status === "True") status = "crash_loop";
  else if (ready?.status === "True") status = "running";
  else if (progressing?.status === "True") status = "starting";
  else if (ready?.status === "False") status = "stopped";

  return {
    id: app.metadata?.name ?? "",
    runtime: app.spec?.runtime,
    command: app.spec?.command ?? "",
    args: app.spec?.args,
    port: app.spec?.port ?? 0,
    status,
    pid: app.status?.currentPid ?? 0,
    uptime_ms: app.status?.uptimeMs ?? 0,
    restart_count: app.status?.restartCount ?? 0,
    health_failures: app.status?.healthFailures ?? 0,
  };
}

export { MODE as apiMode };
export type { AppView, StatsView, Condition };
