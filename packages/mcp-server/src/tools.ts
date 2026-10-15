/**
 * Creek MCP Tools — protocol translator layer.
 *
 * Each tool maps to an existing Creek API endpoint.
 * No business logic here — just translate MCP tool calls to HTTP requests.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./types.js";
import { missingKeyResult, resolveApiKey } from "./auth.js";
import { provePreview } from "./proof.js";

export interface ToolContext {
  env: Env;
  clientIp: string;
  requestHeaders: Headers;
  /** Polling budgets; tests shrink them. Defaults suit a Worker request. */
  timing?: Partial<Timing>;
}

export interface Timing {
  /** How long deploy / deploy_demo wait for a sandbox to go live. */
  sandboxMaxWaitMs: number;
  /** Interval between status polls. */
  pollIntervalMs: number;
}

const DEFAULT_TIMING: Timing = {
  sandboxMaxWaitMs: 30_000,
  pollIntervalMs: 1_000,
};

export function registerTools(server: McpServer, ctx: ToolContext) {
  const { env, clientIp, requestHeaders } = ctx;
  const timing: Timing = { ...DEFAULT_TIMING, ...ctx.timing };
  const sandboxTiming = { maxWaitMs: timing.sandboxMaxWaitMs, intervalMs: timing.pollIntervalMs };

  function requireKey(): string | null {
    return resolveApiKey(requestHeaders);
  }

  function cpHeaders(apiKey: string): Record<string, string> {
    return { "x-api-key": apiKey, "Content-Type": "application/json" };
  }

  function cpFetch(apiKey: string, path: string, init?: RequestInit, opts?: RequestOptions) {
    const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
    return apiRequest(
      "control plane",
      `${base}${path}`,
      {
        ...init,
        headers: { ...cpHeaders(apiKey), ...(init?.headers as Record<string, string> | undefined) },
      },
      opts,
    );
  }

  function sandboxFetch(path: string, init?: RequestInit, opts?: RequestOptions) {
    return apiRequest("sandbox API", `${env.SANDBOX_API_URL}${path}`, init, opts);
  }

  /**
   * Forward client IP + internal secret so sandbox-api rate limits the real
   * client, not the MCP worker. sandbox-api only trusts X-Forwarded-For
   * when X-Internal-Secret matches.
   */
  function apiHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Forwarded-For": clientIp,
      "X-Internal-Secret": env.INTERNAL_SECRET,
    };
  }
  // ================================================================
  // Tier 1: No Auth (Sandbox) — any agent can use these
  // ================================================================

  server.tool(
    "deploy",
    "Deploy files to a sandbox preview (60 min, no account needed)",
    {
      files: z.record(z.string()).describe("File path → file content (UTF-8 string, not base64)"),
      source: z
        .string()
        .optional()
        .describe("Source identifier for tracking (e.g. 'cursor', 'claude')"),
    },
    async ({ files, source }) => {
      // Convert string content to base64 for sandbox API
      const assets: Record<string, string> = {};
      for (const [path, content] of Object.entries(files)) {
        assets[path] = btoa(unescape(encodeURIComponent(content)));
      }

      const posted = await sandboxFetch("/api/sandbox/deploy", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ assets, source: source ?? "mcp" }),
      });
      if (!posted.ok) return posted.result;

      // Poll for active status
      const live = await pollSandbox(asRecord(posted.data), sandboxTiming);
      if (!live.ok) return live.result;
      return sandboxResult(live.status);
    },
  );

  server.tool(
    "deploy_demo",
    "Deploy a sample Creek demo page instantly (zero files needed, great for testing)",
    {},
    async () => {
      const html = `<!DOCTYPE html><html><head><title>Creek MCP Demo</title></head><body><h1>Deployed via MCP</h1><p>This site was deployed by an AI agent using Creek's MCP server.</p></body></html>`;

      const posted = await sandboxFetch("/api/sandbox/deploy", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          assets: { "index.html": btoa(html) },
          source: "mcp-demo",
        }),
      });
      if (!posted.ok) return posted.result;

      const live = await pollSandbox(asRecord(posted.data), sandboxTiming);
      if (!live.ok) return live.result;
      return sandboxResult(live.status, { message: "Demo deployed successfully." });
    },
  );

  server.tool(
    "deploy_status",
    "Check the status of a sandbox deployment",
    {
      sandboxId: z.string().describe("Sandbox ID (e.g. 'a1b2c3d4')"),
    },
    async ({ sandboxId }) => {
      const got = await sandboxFetch(
        `/api/sandbox/${encodeURIComponent(sandboxId)}/status`,
        undefined,
        { extra: { sandboxId } },
      );
      if (!got.ok) return got.result;
      return okResult({ sandboxId, ...asRecord(got.data) });
    },
  );

  server.tool(
    "deploy_delete",
    "Delete a sandbox deployment before it expires",
    {
      sandboxId: z.string().describe("Sandbox ID to delete"),
    },
    async ({ sandboxId }) => {
      const got = await sandboxFetch(
        `/api/sandbox/${encodeURIComponent(sandboxId)}`,
        // The sandbox API checks the creator's IP hash: forward the client
        // IP exactly as deploy does, or every delete is a 403.
        { method: "DELETE", headers: apiHeaders() },
        { extra: { sandboxId } },
      );
      if (!got.ok) return got.result;
      return okResult({ sandboxId, deleted: true });
    },
  );

  // ================================================================
  // Tier 2: Authenticated (Creek account) — agent passes a Creek API key
  // ================================================================

  server.tool(
    "get_build_log",
    "Read the structured build log for a deployment. Use this after `creek deploy` reports a failure to see exactly which phase broke, what the subprocess stderr was, and the CK-* diagnostic code. Returns a summary (status, failing step, error code) plus phase-grouped lines. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z
        .string()
        .describe("Project slug (shown by `creek projects` or `creek status`)"),
      deploymentId: z.string().describe("Deployment id (8-char short id or full uuid)"),
    },
    async ({ projectSlug, deploymentId }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      // Resolve short id → full id if needed. GET /logs requires full uuid.
      let fullId = deploymentId;
      if (fullId.length < 36) {
        const listRes = await cpFetch(apiKey, `/projects/${projectSlug}/deployments`);
        if (!listRes.ok) return listRes.result;
        const list = Array.isArray(listRes.data) ? (listRes.data as Array<{ id: string }>) : [];
        const match = list.find((d) => typeof d.id === "string" && d.id.startsWith(fullId));
        if (!match) {
          return errorResult(
            "not_found",
            `No deployment matches id prefix '${fullId}' in project '${projectSlug}'.`,
          );
        }
        fullId = match.id;
      }

      const res = await cpFetch(apiKey, `/projects/${projectSlug}/deployments/${fullId}/logs`);
      if (!res.ok) return res.result;

      const log = res.data as {
        entries: Array<{
          ts: number;
          step: string;
          stream: string;
          level: string;
          msg: string;
          code?: string;
        }>;
        metadata: null | {
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
        };
        message?: string;
      };

      // Summarise for agent consumption. We put the actionable bits up
      // top (status, failing step, error code, last errors) so even a
      // truncated response is useful, and include the full grouped log
      // below so the agent can dig deeper without a second round-trip.
      const summary =
        log.metadata === null
          ? { status: "unknown", message: log.message ?? "No log available" }
          : {
              status: log.metadata.status,
              errorCode: log.metadata.errorCode,
              errorStep: log.metadata.errorStep,
              lines: log.metadata.lines,
              truncated: log.metadata.truncated,
              // One-line fix hint for known CK-* codes. Same mapping
              // the skill's diagnosis reference uses; keeps these two
              // surfaces saying the same thing. Null when the error
              // code isn't in the mapped set — agent should fall back
              // to the errorStep + log entries in that case.
              suggestedFix: suggestFixForCkCode(log.metadata.errorCode),
              nextResource: log.metadata.errorCode ? "creek://skill/diagnosis" : null,
            };

      // Show only error / fatal lines + the failing-step lines in the
      // short view — the full log is attached below for follow-up.
      const failing = log.metadata?.errorStep ?? null;
      const importantLines = log.entries.filter(
        (e) =>
          e.level === "error" || e.level === "fatal" || (failing !== null && e.step === failing),
      );

      return okResult({
        summary,
        importantLines,
        fullLog: log.entries,
      });
    },
  );

  // ================================================================
  // Tier 1.5: Project read + env (header auth, no apiKey tool arg)
  // ================================================================

  server.tool(
    "list_projects",
    "List projects in the authenticated team. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {},
    async () => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const got = await cpFetch(apiKey, "/projects");
      if (!got.ok) return got.result;
      const rows = Array.isArray(got.data) ? got.data : [];
      const projects = rows.map((p: Record<string, unknown>) => ({
        id: p.id,
        slug: p.slug ?? p.name,
        framework: p.framework ?? null,
        productionDeploymentId: p.productionDeploymentId ?? p.production_deployment_id ?? null,
        productionBranch: p.productionBranch ?? p.production_branch ?? null,
        githubRepo: p.githubRepo ?? p.github_repo ?? null,
        updatedAt: p.updatedAt ?? p.updated_at ?? null,
      }));
      return toolJson({ ok: true, projects });
    },
  );

  server.tool(
    "get_status",
    "Get a project's remote status (slug, framework, production deployment, latest deployment). Pass the project slug from list_projects. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug (from list_projects)"),
    },
    async ({ projectSlug }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const project = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}`);
      if (!project.ok) return project.result;
      const p = project.data as Record<string, unknown>;
      const deploys = await cpFetch(
        apiKey,
        `/projects/${encodeURIComponent(projectSlug)}/deployments`,
      );
      if (!deploys.ok) return deploys.result;
      const list = Array.isArray(deploys.data) ? deploys.data : [];
      const latest = list[0] as Record<string, unknown> | undefined;
      return toolJson({
        ok: true,
        type: "project",
        id: p.id,
        slug: p.slug,
        framework: p.framework ?? null,
        productionDeploymentId: p.productionDeploymentId ?? p.production_deployment_id ?? null,
        productionBranch: p.productionBranch ?? p.production_branch ?? null,
        githubRepo: p.githubRepo ?? p.github_repo ?? null,
        latestDeployment: latest
          ? {
              id: latest.id,
              status: latest.status,
              version: latest.version,
              createdAt: latest.createdAt ?? latest.created_at ?? null,
            }
          : null,
      });
    },
  );

  server.tool(
    "env_ls",
    "List environment variable keys for a project, with the deploy target of each value (production, preview or all). Values are never returned. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
    },
    async ({ projectSlug }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const got = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}/env`);
      if (!got.ok) return got.result;
      // CP `value` is mask(key), a placeholder — not a masked secret. Omit it.
      const rows = Array.isArray(got.data) ? (got.data as Array<Record<string, unknown>>) : [];
      const vars = rows
        .filter((row) => typeof row.key === "string")
        .map((row) => ({
          key: row.key as string,
          // A server without targets applies every variable to all deploys.
          target: typeof row.target === "string" ? row.target : "all",
        }));
      const keys = [...new Set(vars.map((v) => v.key))];
      return toolJson({ ok: true, project: projectSlug, keys, vars });
    },
  );

  server.tool(
    "env_set",
    "Set an environment variable on a project, for production deploys, preview (branch) deploys, or all (default). A key may hold one value per target; a deploy uses its own target's value, else the all value. Use target production for secrets previews must not see. Does not restart the worker — a deploy is required to apply. Values are never echoed. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
      key: z.string().describe("Uppercase env key (e.g. DATABASE_URL)"),
      value: z.string().describe("Secret value (not logged in the tool result)"),
      target: z
        .enum(["all", "production", "preview"])
        .optional()
        .describe("Which deploys get this value. Default: all"),
    },
    async ({ projectSlug, key, value, target }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const wanted = target ?? "all";
      const got = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}/env`, {
        method: "POST",
        body: JSON.stringify({ key, value, ...(target ? { target } : {}) }),
      });
      if (!got.ok) return got.result;
      const stored = (got.data as { target?: unknown } | null)?.target ?? "all";
      if (stored !== wanted) {
        return toolJson(
          {
            ok: false,
            error: "target_unsupported",
            message:
              wanted === "preview"
                ? `The server stored ${key} for all deploys: production deploys now get this preview value, replacing any value production had. Set the production value again with env_set (target all).`
                : `The server stored ${key} for all deploys, previews included. Call env_rm for ${key} if previews must not see it.`,
          },
          true,
        );
      }
      return toolJson({
        ok: true,
        project: projectSlug,
        key,
        target: wanted,
        pendingDeploy: true,
        nextStep: "Call deploy_prod with this projectSlug, or creek deploy --prod --json",
        message: `${key} (${wanted}) stored. Running deployments are unchanged until the next deploy.`,
      });
    },
  );

  server.tool(
    "env_rm",
    "Remove an environment variable from a project: one target's value (production, preview or all), or every value of the key when target is omitted. Does not restart the worker — a deploy is required to apply. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
      key: z.string().describe("Env key to remove"),
      target: z
        .enum(["all", "production", "preview"])
        .optional()
        .describe("Remove only this target's value. Default: every value of the key"),
    },
    async ({ projectSlug, key, target }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      // A server without targets ignores ?target= and deletes the key's only
      // (all-deploys) value; its list has no target field. Refuse instead.
      // The list needs env:read, which a key allowed to delete may lack: on a
      // scope refusal (403) only, go ahead — a server with targets answers a
      // per-target delete itself (409 env_targets_unavailable before its
      // migration). Any other failure stops here.
      if (target && target !== "all") {
        const listed = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}/env`);
        if (!listed.ok && listed.status !== 403) return listed.result;
        const rows =
          listed.ok && Array.isArray(listed.data)
            ? (listed.data as Array<Record<string, unknown>>)
            : [];
        if (rows.length > 0 && rows.every((r) => r.target === undefined)) {
          return toolJson(
            {
              ok: false,
              error: "target_unsupported",
              message: `The server does not support targets, so it would remove the value ${key} has for all deploys. Nothing was removed.`,
            },
            true,
          );
        }
      }
      const query = target ? `?target=${encodeURIComponent(target)}` : "";
      const got = await cpFetch(
        apiKey,
        `/projects/${encodeURIComponent(projectSlug)}/env/${encodeURIComponent(key)}${query}`,
        { method: "DELETE" },
      );
      if (!got.ok) return got.result;
      return toolJson({
        ok: true,
        project: projectSlug,
        key,
        ...(target ? { target } : {}),
        pendingDeploy: true,
        nextStep: "Call deploy_prod with this projectSlug, or creek deploy --prod --json",
      });
    },
  );

  server.tool(
    "deploy_prod",
    "Trigger a production deploy of the latest commit on the project's GitHub production branch (same as `creek deploy --from-github --prod`). Returns as soon as the build is dispatched — poll get_status, list_deployments, or get_build_log for progress. Requires a GitHub connection on the project. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug (from list_projects)"),
    },
    async ({ projectSlug }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const got = await cpFetch(apiKey, "/github/deploy-latest", {
        method: "POST",
        body: JSON.stringify({ projectId: projectSlug }),
      });
      if (!got.ok) return got.result;
      const data = got.data as { commitSha?: string; branch?: string };
      return toolJson({
        ok: true,
        project: projectSlug,
        triggered: true,
        branch: data.branch ?? null,
        commitSha: data.commitSha ?? null,
        pending: true,
        nextStep: "Call get_status or list_deployments, then get_build_log if it fails",
        message:
          "Build dispatched. Production will update when the remote build finishes. This tool does not wait for the deploy.",
      });
    },
  );

  server.tool(
    "list_deployments",
    "List recent deployments for a project (newest first). Each row includes triggerType so rollback can skip synthetic rollback rows. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
    },
    async ({ projectSlug }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const got = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}/deployments`);
      if (!got.ok) return got.result;
      const rows = Array.isArray(got.data) ? (got.data as Array<Record<string, unknown>>) : [];
      const deployments = rows.map((d) => ({
        id: d.id,
        version: d.version,
        status: d.status,
        branch: d.branch ?? null,
        triggerType: d.triggerType ?? d.trigger_type ?? null,
        createdAt: d.createdAt ?? d.created_at ?? null,
      }));
      return toolJson({ ok: true, project: projectSlug, deployments });
    },
  );

  server.tool(
    "rollback",
    "Roll production back to a previous active deployment. deploymentId is required — pick an active row from list_deployments whose triggerType is not rollback (implicit previous-production selection can land on a synthetic rollback row). Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
      deploymentId: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Target deployment id from list_deployments. Must be an active non-rollback deployment, not current production.",
        ),
      message: z.string().optional().describe("Optional rollback reason"),
    },
    async ({ projectSlug, deploymentId, message }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      // Never omit deploymentId: an empty target makes the control plane pick
      // "previous production", which after one rollback can be a synthetic row.
      const id = deploymentId.trim();
      if (!id) {
        return toolJson(
          {
            ok: false,
            error: "deployment_id_required",
            message:
              "rollback requires a non-empty deploymentId from list_deployments (active, triggerType !== rollback).",
          },
          true,
        );
      }
      const body: Record<string, string> = { deploymentId: id };
      if (message !== undefined && message.length > 0) body.message = message;
      const got = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}/rollback`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!got.ok) return got.result;
      return toolJson({
        ok: true,
        project: projectSlug,
        ...(got.data as Record<string, unknown>),
      });
    },
  );

  // ================================================================
  // Tier 2: Resource management
  // ================================================================

  server.tool(
    "list_resources",
    "List all team-owned resources (databases, storage, cache, AI). Optionally filter by kind. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      kind: z
        .enum(["database", "storage", "cache", "ai"])
        .optional()
        .describe("Filter by resource kind"),
    },
    async ({ kind }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, "/resources");
      if (!res.ok) return res.result;
      const data = asRecord(res.data);
      const all = Array.isArray(data.resources)
        ? (data.resources as Array<{ kind?: unknown }>)
        : [];
      const resources = kind ? all.filter((r) => r.kind === kind) : all;
      return okResult({ resources });
    },
  );

  server.tool(
    "create_resource",
    "Create a new team-owned resource. The backing Cloudflare resource (D1/R2/KV) is auto-provisioned. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      kind: z.enum(["database", "storage", "cache", "ai"]).describe("Resource kind"),
      name: z.string().describe("Resource name (lowercase, dash/underscore, ≤63 chars)"),
    },
    async ({ kind, name }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, "/resources", {
        method: "POST",
        body: JSON.stringify({ kind, name }),
      });
      if (!res.ok) return res.result;
      return okResult(asRecord(res.data));
    },
  );

  server.tool(
    "attach_resource",
    "Attach a team resource to a project under a given ENV var name (e.g. DB, STORAGE). The project's Worker will see it as env.<bindingName>. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
      resourceId: z.string().describe("Resource ID (from list_resources)"),
      bindingName: z.string().describe("ENV var name, uppercase (e.g. DB, CACHE, STORAGE)"),
    },
    async ({ projectSlug, resourceId, bindingName }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, `/projects/${projectSlug}/bindings`, {
        method: "POST",
        body: JSON.stringify({ resourceId, bindingName }),
      });
      if (!res.ok) return res.result;
      return okResult({
        project: projectSlug,
        resourceId,
        bindingName,
        message: `Attached resource ${resourceId} to ${projectSlug} as env.${bindingName}. It takes effect on the next deploy.`,
      });
    },
  );

  server.tool(
    "detach_resource",
    "Remove a resource binding from a project. The resource itself is not deleted. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
      bindingName: z.string().describe("ENV var name to detach (e.g. DB)"),
    },
    async ({ projectSlug, bindingName }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, `/projects/${projectSlug}/bindings/${bindingName}`, {
        method: "DELETE",
      });
      if (!res.ok) return res.result;
      return okResult({
        project: projectSlug,
        bindingName,
        detached: true,
        message: `Detached env.${bindingName} from ${projectSlug}. It takes effect on the next deploy.`,
      });
    },
  );

  server.tool(
    "delete_resource",
    "Delete a team-owned resource. This is permanent: the D1 database or KV namespace behind it is queued for deletion with all its data, and an R2 bucket is deleted only if it is empty. Fails if any project still has a binding to it — detach first. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      resourceId: z.string().describe("Resource ID"),
    },
    async ({ resourceId }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, `/resources/${resourceId}`, { method: "DELETE" });
      if (!res.ok) return res.result;
      return okResult({ resourceId, deleted: true, ...asRecord(res.data) });
    },
  );

  server.tool(
    "rename_resource",
    "Rename a team-owned resource. The stable UUID and all project bindings are preserved — only the display name changes. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      resourceId: z.string().describe("Resource ID"),
      name: z.string().describe("New name (lowercase, dash/underscore, ≤63 chars)"),
    },
    async ({ resourceId, name }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, `/resources/${resourceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return res.result;
      return okResult({ resourceId, name, ...asRecord(res.data) });
    },
  );

  server.tool(
    "query_database",
    "Execute a SQL query against a team-owned D1 database. Returns columns, rows, and metadata (changes, duration). Use list_resources to find the resourceId first. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      resourceId: z.string().describe("Resource ID of a database (from list_resources)"),
      sql: z.string().describe("SQL query to execute"),
      params: z.array(z.unknown()).optional().describe("Bind parameters for the query"),
    },
    async ({ resourceId, sql, params }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const res = await cpFetch(apiKey, `/resources/${resourceId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql, params: params ?? [] }),
      });
      if (!res.ok) return res.result;
      return okResult(asRecord(res.data));
    },
  );
}

// ================================================================
// CK-code → fix hint
// ================================================================
//
// Mirrors the table in skills/creek/references/diagnosis.md. Keep in
// sync — both surfaces should suggest the same fix for the same code.
// When adding a new CK-* in creek doctor rules, add the hint here
// and in diagnosis.md in the same commit.

const CK_FIX_HINTS: Record<string, string> = {
  "CK-NO-CONFIG":
    "Run `creek init` to scaffold a creek.toml, or cd to a directory that contains creek.toml / wrangler.* / package.json / index.html.",
  "CK-NOTHING-TO-DEPLOY":
    "Run the project's build command so there's output in [build].output, or set [build].command in creek.toml if the project needs one. If the project has server code / API routes, also set [build].worker — the build alone never declares it.",
  "CK-RESOURCES-NO-WORKER":
    'Resources are declared but no worker entry — the deploy is a static SPA and /api/* serves index.html. Set [build].worker in creek.toml (e.g. worker = "worker/index.ts"), or remove [resources] if the site is purely static.',
  "CK-WORKER-UNDECLARED":
    "A worker-shaped file exists on disk but no worker entry is declared, so it will not be deployed. Point [build].worker in creek.toml at it, or delete the file if unused.",
  "CK-DB-DUAL-DRIVER-SPLIT":
    "Consolidate the split db.local.ts + db.prod.ts files. Share schema.ts and routes.ts; keep only thin boot files (server/local.ts for dev, server/worker.ts for prod) that differ in driver setup. See examples/vite-react-drizzle.",
  "CK-SYNC-SQLITE":
    "better-sqlite3 is synchronous and won't run on Workers. Migrate to an async ORM with a D1 adapter — Drizzle or Kysely are the drop-in paths.",
  "CK-PRISMA-SQLITE":
    "Prisma's SQLite datasource isn't supported on Cloudflare Workers. Switch to Drizzle or Kysely with a D1 adapter.",
  "CK-RUNTIME-LOCKIN":
    "The project imports from @solcreek/* runtime packages. For a portable build that can deploy outside Creek, replace those with driver-level imports (e.g. drizzle-orm/d1 instead of creek's db re-export).",
  "CK-CONFIG-OVERLAP":
    "Both creek.toml and wrangler.* are present. Pick one as the source of truth — creek.toml is preferred; remove wrangler.* or update any shared fields to match.",
};

function suggestFixForCkCode(code: string | null): string | null {
  if (!code) return null;
  return CK_FIX_HINTS[code] ?? null;
}

// ================================================================
// Result envelope
// ================================================================
//
// Every tool answers with one JSON text block:
//   success: { ok: true, ...data }
//   failure: { ok: false, error, message, ...details } and isError: true
// so an agent branches on `ok` / `error` instead of parsing prose.

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

export function toolJson(data: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export function okResult(data: Record<string, unknown> = {}): ToolResult {
  // `ok` is the envelope's, not the API's: an upstream `ok` never wins.
  const { ok: _ok, ...rest } = data;
  return toolJson({ ok: true, ...rest });
}

export function errorResult(
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  return toolJson({ ok: false, error, message, ...extra }, true);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ================================================================
// Upstream requests (control plane, sandbox API)
// ================================================================

export interface RequestOptions {
  /** Merged into the failure envelope (e.g. the sandboxId it concerns). */
  extra?: Record<string, unknown>;
  /**
   * An earlier request in this tool call already changed something, so a
   * network failure now is never retryable: re-running the tool repeats it.
   */
  applied?: boolean;
}

export type Fetched =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; result: ToolResult };

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Fetch failure causes that prove the request was never written: name
 * resolution and the TCP connect happen first. Same list as the CLI's
 * request ledger (packages/cli/src/utils/request-ledger.ts). The Workers
 * runtime rarely names a cause, so a failed mutation there is reported as
 * possibly applied — the safe direction.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function failureReason(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return undefined;
}

function unreachableResult(
  service: string,
  method: string,
  err: unknown,
  phase: "connect" | "body",
  opts: RequestOptions,
): ToolResult {
  const reason = failureReason(err);
  const notSent = phase === "connect" && reason !== undefined && NOT_SENT_CODES.has(reason);
  // Retry only when nothing this tool call did can have been applied.
  const retryable = !opts.applied && (SAFE_METHODS.has(method) || notSent);
  const text = err instanceof Error ? err.message : String(err);
  const advice = retryable
    ? "Nothing was changed; retrying is safe."
    : opts.applied
      ? "An earlier step of this call was already applied; check its effect instead of re-running the tool."
      : "The request may have been applied; check its effect before retrying.";
  return errorResult(
    "api_unreachable",
    `Could not reach the Creek ${service} (${text}${reason ? `: ${reason}` : ""}). ${advice}`,
    {
      retryable,
      ...(reason ? { reason } : {}),
      ...(!retryable ? { mayHaveApplied: true } : {}),
      ...opts.extra,
    },
  );
}

/**
 * One request to a Creek API. Never throws: a network failure becomes
 * `api_unreachable` (with `retryable`), an HTTP error keeps the API's
 * `error` code, `message`, status and other fields (`required` / `granted`
 * on insufficient_scope, `conflicts` on binding_conflict) as `details`.
 */
export async function apiRequest(
  service: string,
  url: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
): Promise<Fetched> {
  const method = (init.method ?? "GET").toUpperCase();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      ok: false,
      status: null,
      result: unreachableResult(service, method, err, "connect", opts),
    };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // The connection broke while the body was read: the request was sent.
    return {
      ok: false,
      status: null,
      result: unreachableResult(service, method, err, "body", opts),
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: res.statusText };
  }
  if (!res.ok) {
    const { error, message, ...details } = asRecord(data);
    return {
      ok: false,
      status: res.status,
      result: errorResult(
        typeof error === "string" ? error : "api_error",
        typeof message === "string" ? message : res.statusText || `HTTP ${res.status}`,
        {
          status: res.status,
          ...(Object.keys(details).length > 0 ? { details } : {}),
          ...opts.extra,
        },
      ),
    };
  }
  return { ok: true, status: res.status, data };
}

// ================================================================
// Helpers
// ================================================================

async function sandboxResult(
  status: {
    previewUrl: string;
    sandboxId: string;
    deployDurationMs?: number;
    expiresAt?: string;
    expiresInSeconds?: number;
  },
  extra: Record<string, unknown> = {},
) {
  const proof = await provePreview(status.previewUrl);
  const payload = {
    url: status.previewUrl,
    sandboxId: status.sandboxId,
    deployDurationMs: status.deployDurationMs,
    expiresAt: status.expiresAt,
    expiresInSeconds: status.expiresInSeconds,
    proof,
  };
  if (!proof.ok) {
    return errorResult(
      "verify_failed",
      `Sandbox ${status.sandboxId} deployed, but its preview URL did not answer as a live site${proof.error ? ` (${proof.error})` : ""}.`,
      payload,
    );
  }
  return okResult({ ...payload, ...extra });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sandbox API's 202 answer to POST /api/sandbox/deploy. */
interface SandboxCreated {
  sandboxId?: string;
  statusUrl?: string;
  previewUrl?: string;
}

/**
 * Poll a freshly created sandbox until it is active. Never throws: every
 * other outcome (failed, expired, timed out, status unreadable) is an error
 * result that still carries the sandboxId, so the agent can follow up with
 * deploy_status / deploy_delete instead of deploying again. The sandbox
 * exists by now, so nothing here is retryable.
 */
async function pollSandbox(
  created: SandboxCreated,
  timing: { maxWaitMs: number; intervalMs: number },
): Promise<{ ok: true; status: any } | { ok: false; result: ToolResult }> {
  const sandboxId =
    created.sandboxId ?? /\/sandbox\/([^/]+)\/status$/.exec(created.statusUrl ?? "")?.[1] ?? null;
  const ref = {
    sandboxId,
    ...(created.previewUrl ? { url: created.previewUrl } : {}),
    nextStep: sandboxId
      ? `Call deploy_status with sandboxId ${sandboxId}; do not deploy again.`
      : "Do not deploy again; the sandbox may still go live.",
  };
  if (!created.statusUrl) {
    return {
      ok: false,
      result: errorResult(
        "api_error",
        "The sandbox API accepted the deploy but returned no status URL.",
        ref,
      ),
    };
  }

  const start = Date.now();
  let last: string | null = null;
  while (Date.now() - start < timing.maxWaitMs) {
    const got = await apiRequest("sandbox API", created.statusUrl, undefined, {
      applied: true,
      extra: ref,
    });
    if (!got.ok) return { ok: false, result: got.result };
    const status = asRecord(got.data) as any;
    last = typeof status.status === "string" ? status.status : null;
    if (last === "active") return { ok: true, status: { sandboxId, ...status } };
    if (last === "failed") {
      return {
        ok: false,
        result: errorResult(
          "deploy_failed",
          `Sandbox deploy failed: ${status.errorMessage ?? "unknown error"}`,
          {
            sandboxId,
            failedStep: status.failedStep ?? null,
            errorMessage: status.errorMessage ?? null,
          },
        ),
      };
    }
    if (last === "expired") {
      return {
        ok: false,
        result: errorResult("sandbox_expired", "The sandbox expired before it went live.", {
          sandboxId,
        }),
      };
    }
    await sleep(timing.intervalMs);
  }

  return {
    ok: false,
    result: errorResult(
      "timeout",
      `Sandbox${sandboxId ? ` ${sandboxId}` : ""} was not live after ${Math.round(timing.maxWaitMs / 1000)}s (last status: ${last ?? "unknown"}). It may still finish.`,
      { ...ref, sandboxStatus: last, retryable: false },
    ),
  };
}
