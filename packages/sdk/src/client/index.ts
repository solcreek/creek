import type {
  Project,
  Deployment,
  CustomDomain,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateDeploymentResponse,
  DeploymentStatusResponse,
  ApiError,
  LogEntry,
  LogQueryFilters,
  LogQueryResponse,
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

  // --- Logs ---

  /**
   * Read structured log entries for a project from the R2 archive
   * written by the tail-worker. Server applies team-scoped auth; the
   * URL never carries a teamSlug. See packages/control-plane/src/
   * modules/logs/routes.ts for the source-of-truth filter shape.
   */
  async getLogs(
    projectSlug: string,
    filters?: LogQueryFilters,
  ): Promise<LogQueryResponse> {
    const url = new URL(`/projects/${projectSlug}/logs`, "http://x"); // base discarded by request()
    if (filters?.since) url.searchParams.set("since", filters.since);
    if (filters?.until) url.searchParams.set("until", filters.until);
    if (filters?.deployment) url.searchParams.set("deployment", filters.deployment);
    if (filters?.branch) url.searchParams.set("branch", filters.branch);
    if (filters?.search) url.searchParams.set("search", filters.search);
    if (filters?.limit !== undefined) url.searchParams.set("limit", String(filters.limit));
    for (const o of filters?.outcomes ?? []) url.searchParams.append("outcome", o);
    for (const s of filters?.scriptTypes ?? []) url.searchParams.append("scriptType", s);
    for (const l of filters?.levels ?? []) url.searchParams.append("level", l);
    return this.request("GET", url.pathname + url.search);
  }

  /**
   * Mint a 5-min WebSocket subscribe token for `creek logs --follow`.
   * Returns the wsUrl ready to connect to.
   */
  async getLogsWsToken(projectSlug: string): Promise<{
    token: string;
    expiresAt: number;
    slug: string;
    wsUrl: string;
  }> {
    return this.request("GET", `/projects/${projectSlug}/logs/ws-token`);
  }

  // --- Build Logs ---

  /**
   * Upload a build log for a deployment. Body is ndjson — one JSON
   * object per line: {ts, step, stream, level, msg, code?}.
   * Server scrubs secrets + gzips before writing R2.
   */
  async uploadBuildLog(
    deploymentId: string,
    ndjsonBody: string,
    opts: {
      status: "success" | "failed" | "running";
      errorCode?: string | null;
      errorStep?: string | null;
      startedAt?: number;
    },
  ): Promise<{ ok: boolean; bytes: number; lines: number; truncated: boolean }> {
    const qs = new URLSearchParams({ status: opts.status });
    if (opts.errorCode) qs.set("errorCode", opts.errorCode);
    if (opts.errorStep) qs.set("errorStep", opts.errorStep);
    if (opts.startedAt !== undefined) qs.set("startedAt", String(opts.startedAt));

    const res = await fetch(`${this.baseUrl}/builds/${deploymentId}/logs?${qs.toString()}`, {
      method: "POST",
      headers: {
        "x-api-key": this.token,
        "Content-Type": "application/x-ndjson",
      },
      body: ndjsonBody,
    });
    if (!res.ok) {
      throw new CreekApiError(
        res.status,
        "build_log_upload_failed",
        `Build log upload failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<{ ok: boolean; bytes: number; lines: number; truncated: boolean }>;
  }

  /**
   * Read archived build log for a deployment. Returns parsed entries
   * + metadata (status, sizes, truncation flag, CK-code on failure).
   * Caller must be in the deployment's team (server-side check).
   */
  async getBuildLog(
    projectSlug: string,
    deploymentId: string,
  ): Promise<{
    entries: Array<{
      ts: number;
      step: string;
      stream: string;
      level: string;
      msg: string;
      code?: string;
    }>;
    metadata: {
      deploymentId: string;
      status: "running" | "success" | "failed";
      startedAt: number;
      endedAt: number | null;
      bytes: number;
      lines: number;
      truncated: boolean;
      errorCode: string | null;
      errorStep: string | null;
      r2Key: string;
    } | null;
    message?: string;
  }> {
    return this.request(
      "GET",
      `/projects/${projectSlug}/deployments/${deploymentId}/logs`,
    );
  }

  // --- Resources v2 (team-owned) ---

  async listResources(): Promise<{
    resources: Array<{
      id: string;
      teamId: string;
      kind: string;
      name: string;
      cfResourceId: string | null;
      cfResourceType: string | null;
      status: string;
      createdAt: number;
      updatedAt: number;
    }>;
  }> {
    return this.request("GET", "/resources");
  }

  async createResource(input: {
    kind: "database" | "storage" | "cache" | "ai";
    name: string;
    cfResourceId?: string;
    cfResourceType?: string;
  }): Promise<{
    id: string;
    teamId: string;
    kind: string;
    name: string;
    status: string;
  }> {
    return this.request("POST", "/resources", input);
  }

  async getResource(id: string): Promise<{
    id: string;
    teamId: string;
    kind: string;
    name: string;
    cfResourceId: string | null;
    cfResourceType: string | null;
    status: string;
    bindings: Array<{ projectId: string; projectSlug: string; bindingName: string }>;
  }> {
    return this.request("GET", `/resources/${id}`);
  }

  async renameResource(id: string, name: string): Promise<{ id: string; name: string }> {
    return this.request("PATCH", `/resources/${id}`, { name });
  }

  async deleteResource(id: string): Promise<{ id: string; status: string }> {
    return this.request("DELETE", `/resources/${id}`);
  }

  async listBindings(projectSlug: string): Promise<{
    bindings: Array<{
      bindingName: string;
      resourceId: string;
      kind: string;
      name: string;
      status: string;
      createdAt: number;
    }>;
  }> {
    return this.request("GET", `/projects/${projectSlug}/bindings`);
  }

  async attachBinding(
    projectSlug: string,
    input: { resourceId: string; bindingName: string },
  ): Promise<{
    projectId: string;
    bindingName: string;
    resourceId: string;
    createdAt: number;
  }> {
    return this.request("POST", `/projects/${projectSlug}/bindings`, input);
  }

  async detachBinding(projectSlug: string, bindingName: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/projects/${projectSlug}/bindings/${bindingName}`);
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
