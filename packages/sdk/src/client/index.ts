import type {
  Project,
  Deployment,
  CustomDomain,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateDeploymentResponse,
  DeploymentStatusResponse,
  ApiError,
} from "../types/index.js";

export class CreekClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": this.token,
    };

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
        headers["Content-Type"] = "application/octet-stream";
        init.body = body instanceof Uint8Array ? body.buffer as ArrayBuffer : body;
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }

    const res = await fetch(`${this.baseUrl}${path}`, init);

    if (!res.ok) {
      const err = (await res.json().catch(() => ({
        error: "unknown",
        message: res.statusText,
      }))) as ApiError;
      if (res.status === 401) {
        throw new CreekAuthError(err.message);
      }
      throw new CreekApiError(res.status, err.error, err.message);
    }

    return res.json() as Promise<T>;
  }

  // --- Auth ---

  async getSession(): Promise<{ user: { id: string; name: string; email: string } } | null> {
    try {
      return await this.request("GET", "/api/auth/get-session");
    } catch {
      return null;
    }
  }

  // --- Projects ---

  async listProjects(): Promise<Project[]> {
    return this.request("GET", "/projects");
  }

  async createProject(data: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.request("POST", "/projects", data);
  }

  async getProject(idOrSlug: string): Promise<Project> {
    return this.request("GET", `/projects/${idOrSlug}`);
  }

  async listDeployments(projectSlug: string): Promise<Deployment[]> {
    return this.request("GET", `/projects/${projectSlug}/deployments`);
  }

  /**
   * Trigger a deploy of the latest commit on the project's production branch
   * using its github_connection. The server runs handlePush in waitUntil, so
   * this returns as soon as the row has been dispatched — callers should poll
   * `listDeployments` to follow the status.
   */
  async deployFromGithub(
    projectIdOrSlug: string,
  ): Promise<{ ok: boolean; commitSha: string; branch: string }> {
    return this.request("POST", "/github/deploy-latest", { projectId: projectIdOrSlug });
  }

  async createDeployment(
    projectId: string,
    options?: { branch?: string; commitSha?: string; commitMessage?: string },
  ): Promise<CreateDeploymentResponse & { cacheHit?: boolean }> {
    return this.request("POST", `/projects/${projectId}/deployments`, options);
  }

  async uploadDeploymentBundle(
    projectId: string,
    deploymentId: string,
    bundle: Record<string, unknown>,
  ): Promise<{ ok: boolean; url: string; previewUrl: string }> {
    return this.request(
      "PUT",
      `/projects/${projectId}/deployments/${deploymentId}/bundle`,
      bundle,
    );
  }

  // --- Environment Variables ---

  async listEnvVars(
    projectId: string,
  ): Promise<{ key: string; value: string }[]> {
    return this.request("GET", `/projects/${projectId}/env`);
  }

  async setEnvVar(
    projectId: string,
    key: string,
    value: string,
  ): Promise<{ ok: boolean; key: string }> {
    return this.request("POST", `/projects/${projectId}/env`, { key, value });
  }

  async deleteEnvVar(
    projectId: string,
    key: string,
  ): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/projects/${projectId}/env/${key}`);
  }

  // --- Queue ---

  async sendQueueMessage(
    projectId: string,
    message: unknown,
  ): Promise<{ ok: boolean; queueId: string }> {
    return this.request("POST", `/projects/${projectId}/queue/send`, { message });
  }

  // --- Triggers ---

  async updateCronTriggers(
    projectId: string,
    cron: string[],
  ): Promise<{ ok: boolean; cron: string[]; queue: boolean; queueRequiresRedeploy: boolean }> {
    return this.request("PATCH", `/projects/${projectId}/triggers`, { cron });
  }

  async updateTriggers(
    projectId: string,
    patch: { cron?: string[]; queue?: boolean },
  ): Promise<{ ok: boolean; cron: string[]; queue: boolean; queueRequiresRedeploy: boolean }> {
    return this.request("PATCH", `/projects/${projectId}/triggers`, patch);
  }

  async getDeploymentStatus(
    projectId: string,
    deploymentId: string,
  ): Promise<DeploymentStatusResponse> {
    return this.request(
      "GET",
      `/projects/${projectId}/deployments/${deploymentId}`,
    );
  }

  async promoteDeployment(
    projectId: string,
    deploymentId: string,
  ): Promise<{ ok: boolean }> {
    return this.request(
      "POST",
      `/projects/${projectId}/deployments/${deploymentId}/promote`,
    );
  }

  async rollback(
    projectId: string,
    options?: { deploymentId?: string; message?: string },
  ): Promise<{
    ok: boolean;
    deploymentId: string;
    rolledBackTo: string;
    previousDeploymentId: string;
    url: string;
  }> {
    return this.request("POST", `/projects/${projectId}/rollback`, options ?? {});
  }

  // --- Custom Domains ---

  async listDomains(
    projectId: string,
  ): Promise<CustomDomain[]> {
    return this.request("GET", `/projects/${projectId}/domains`);
  }

  async addDomain(
    projectId: string,
    hostname: string,
  ): Promise<{
    domain: CustomDomain;
    verification?: {
      cname: { name: string; target: string };
      txt: { type: string; name: string; value: string };
    } | null;
  }> {
    return this.request("POST", `/projects/${projectId}/domains`, { hostname });
  }

  async deleteDomain(
    projectId: string,
    domainId: string,
  ): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/projects/${projectId}/domains/${domainId}`);
  }

  async activateDomain(
    projectId: string,
    domainId: string,
  ): Promise<{ ok: boolean }> {
    return this.request(
      "POST",
      `/projects/${projectId}/domains/${domainId}/activate`,
    );
  }
}

export class CreekApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreekApiError";
  }
}

/**
 * Thrown on 401 responses. CLI should catch this and prompt re-login.
 */
export class CreekAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreekAuthError";
  }
}
