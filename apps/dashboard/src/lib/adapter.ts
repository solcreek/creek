import { api } from "./api";
import { createCreekdClient, type AppView, type StatsView, type CreekdClient } from "./creekd-client";

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

// --- creekd typed client (spec-generated) ---

let _creekdClient: CreekdClient | null = null;

function creekd(): CreekdClient {
  if (!_creekdClient) {
    const url = import.meta.env.VITE_API_URL || "http://localhost:9080";
    const token = import.meta.env.VITE_CREEKD_TOKEN || "";
    _creekdClient = createCreekdClient(url, token || undefined);
  }
  return _creekdClient;
}

// --- Unified API (thin wrappers over spec-generated client) ---

export async function listApps(): Promise<AppView[]> {
  if (MODE === "creekd") {
    const { data, error } = await creekd().GET("/v1/apps");
    if (error) throw new Error(error.error);
    return data.apps;
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

export async function getApp(id: string): Promise<AppView> {
  if (MODE === "creekd") {
    const { data, error } = await creekd().GET("/v1/apps/{id}", { params: { path: { id } } });
    if (error) throw new Error(error.error);
    return data;
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
  };
}

export async function getAppStats(id: string): Promise<StatsView> {
  if (MODE === "creekd") {
    const { data, error } = await creekd().GET("/v1/apps/{id}/stats", { params: { path: { id } } });
    if (error) throw new Error(error.error);
    return data;
  }
  return { id, cgroup_enabled: false };
}

export async function getAppLogs(id: string, tail = 100): Promise<string> {
  if (MODE === "creekd") {
    const url = import.meta.env.VITE_API_URL || "http://localhost:9080";
    const token = import.meta.env.VITE_CREEKD_TOKEN || "";
    const res = await fetch(`${url}/v1/apps/${id}/logs?tail=${tail}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.text();
  }
  const data = await api<{ lines: string[] }>(`/projects/${id}/logs`);
  return data.lines.join("\n");
}

export async function stopApp(id: string): Promise<void> {
  if (MODE === "creekd") {
    const { error } = await creekd().DELETE("/v1/apps/{id}", { params: { path: { id } } });
    if (error) throw new Error(error.error);
    return;
  }
  await api(`/projects/${id}`, { method: "DELETE" });
}

export async function restartApp(id: string): Promise<AppView> {
  if (MODE === "creekd") {
    const { data, error } = await creekd().POST("/v1/apps/{id}/restart", { params: { path: { id } } });
    if (error) throw new Error(error.error);
    return data;
  }
  await api(`/projects/${id}/restart`, { method: "POST" });
  return getApp(id);
}

export { MODE as apiMode };
export type { AppView, StatsView };
