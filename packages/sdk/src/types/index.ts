/**
 * API response types.
 *
 * These match the D1 column names (snake_case) because routes return raw rows
 * via SELECT *. A camelCase transform layer may be added in the future; until
 * then these types are the source of truth for what the API actually returns.
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

export interface Deployment {
  id: string;
  project_id: string;
  version: number;
  status: DeploymentStatus;
  branch: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  trigger_type: DeploymentTrigger;
  failed_step: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
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
  return framework === "nextjs"
    || framework === "tanstack-start"
    || framework === "react-router"
    || framework === "sveltekit"
    || framework === "solidstart"
    || framework === "nuxt";
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
}
