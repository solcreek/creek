import createClient from "openapi-fetch";
import type { paths, components } from "./generated/creekd";

export type AppView = components["schemas"]["AppView"];
export type App = components["schemas"]["App"];
export type AppMetadata = components["schemas"]["AppMetadata"];
export type AppSpec = components["schemas"]["AppSpec"];
export type AppStatus = components["schemas"]["AppStatus"];
export type Condition = components["schemas"]["Condition"];
export type Release = components["schemas"]["Release"];
export type StatsView = components["schemas"]["StatsView"];
export type AppEvent = components["schemas"]["AppEvent"];
export type VolumeView = components["schemas"]["VolumeView"];
export type SpawnRequest = components["schemas"]["SpawnRequest"];
export type DeployRequest = components["schemas"]["DeployRequest"];
export type ErrorResponse = components["schemas"]["ErrorResponse"];
export type HostkeyInfo = components["schemas"]["HostkeyInfo"];

export function createCreekdClient(baseUrl: string, token?: string) {
  return createClient<paths>({
    baseUrl,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export type CreekdClient = ReturnType<typeof createCreekdClient>;
