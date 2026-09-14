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
}

export function registerTools(server: McpServer, ctx: ToolContext) {
  const { env, clientIp, requestHeaders } = ctx;

  function requireKey(): string | null {
    return resolveApiKey(requestHeaders);
  }

  function cpHeaders(apiKey: string): Record<string, string> {
    return { "x-api-key": apiKey, "Content-Type": "application/json" };
  }

  function toolJson(data: unknown, isError = false) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      ...(isError ? { isError: true as const } : {}),
    };
  }

  async function cpFetch(apiKey: string, path: string, init?: RequestInit) {
    const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...cpHeaders(apiKey), ...(init?.headers as Record<string, string> | undefined) },
    });
    const data = await res.json().catch(() => ({ message: res.statusText }));
    if (!res.ok) {
      const err = data as { error?: string; message?: string };
      return {
        ok: false as const,
        result: toolJson(
          { ok: false, error: err.error ?? "api_error", message: err.message ?? res.statusText },
          true,
        ),
      };
    }
    return { ok: true as const, data };
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

      const res = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/deploy`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ assets, source: source ?? "mcp" }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ message: res.statusText }))) as any;
        return {
          content: [
            { type: "text" as const, text: `Deploy failed: ${err.message ?? res.statusText}` },
          ],
          isError: true,
        };
      }

      const deploy = (await res.json()) as any;

      // Poll for active status
      const status = await pollStatus(deploy.statusUrl);
      return sandboxResult(status);
    },
  );

  server.tool(
    "deploy_demo",
    "Deploy a sample Creek demo page instantly (zero files needed, great for testing)",
    {},
    async () => {
      const html = `<!DOCTYPE html><html><head><title>Creek MCP Demo</title></head><body><h1>Deployed via MCP</h1><p>This site was deployed by an AI agent using Creek's MCP server.</p></body></html>`;

      const res = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/deploy`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          assets: { "index.html": btoa(html) },
          source: "mcp-demo",
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ message: res.statusText }))) as any;
        return {
          content: [{ type: "text" as const, text: `Demo deploy failed: ${err.message}` }],
          isError: true,
        };
      }

      const deploy = (await res.json()) as any;
      const status = await pollStatus(deploy.statusUrl);
      return sandboxResult(status, { message: "Demo deployed successfully." });
    },
  );

  server.tool(
    "deploy_status",
    "Check the status of a sandbox deployment",
    {
      sandboxId: z.string().describe("Sandbox ID (e.g. 'a1b2c3d4')"),
    },
    async ({ sandboxId }) => {
      const res = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/${sandboxId}/status`);

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Sandbox ${sandboxId} not found` }],
          isError: true,
        };
      }

      const status = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.tool(
    "deploy_delete",
    "Delete a sandbox deployment before it expires",
    {
      sandboxId: z.string().describe("Sandbox ID to delete"),
    },
    async ({ sandboxId }) => {
      const res = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/${sandboxId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ message: res.statusText }))) as any;
        return {
          content: [{ type: "text" as const, text: `Delete failed: ${err.message}` }],
          isError: true,
        };
      }

      return { content: [{ type: "text" as const, text: `Sandbox ${sandboxId} deleted.` }] };
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      // Resolve short id → full id if needed. GET /logs requires full uuid.
      let fullId = deploymentId;
      if (fullId.length < 36) {
        const listRes = await fetch(`${base}/projects/${projectSlug}/deployments`, {
          headers: { "x-api-key": apiKey },
        });
        if (!listRes.ok) {
          const err = (await listRes.json().catch(() => ({ message: listRes.statusText }))) as {
            message?: string;
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `Lookup failed: ${err.message ?? listRes.statusText}`,
              },
            ],
            isError: true,
          };
        }
        const list = (await listRes.json()) as Array<{ id: string }>;
        const match = list.find((d) => d.id.startsWith(fullId));
        if (!match) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No deployment matches id prefix '${fullId}' in project '${projectSlug}'.`,
              },
            ],
            isError: true,
          };
        }
        fullId = match.id;
      }

      const res = await fetch(`${base}/projects/${projectSlug}/deployments/${fullId}/logs`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ message: res.statusText }))) as {
          message?: string;
          error?: string;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Read failed (${res.status}): ${err.message ?? res.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const log = (await res.json()) as {
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

      const payload = {
        summary,
        importantLines,
        fullLog: log.entries,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
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
    "List environment variable keys for a project. Values are never returned. Authenticate with Authorization: Bearer <key> or x-api-key.",
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
      const keys = rows.map((row) => row.key).filter((k): k is string => typeof k === "string");
      return toolJson({ ok: true, project: projectSlug, keys });
    },
  );

  server.tool(
    "env_set",
    "Set an environment variable on a project. Does not restart the worker — a production deploy is required to apply. Values are never echoed. Authenticate with Authorization: Bearer <key> or x-api-key.",
    {
      projectSlug: z.string().describe("Project slug"),
      key: z.string().describe("Uppercase env key (e.g. DATABASE_URL)"),
      value: z.string().describe("Secret value (not logged in the tool result)"),
    },
    async ({ projectSlug, key, value }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const got = await cpFetch(apiKey, `/projects/${encodeURIComponent(projectSlug)}/env`, {
        method: "POST",
        body: JSON.stringify({ key, value }),
      });
      if (!got.ok) return got.result;
      return toolJson({
        ok: true,
        project: projectSlug,
        key,
        pendingDeploy: true,
        nextStep: "creek deploy --prod --json",
        message: `${key} stored. Running worker is unchanged until the next production deploy.`,
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/resources`, { headers: cpHeaders(apiKey) });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ message: res.statusText }))) as any;
        return {
          content: [{ type: "text" as const, text: `Failed: ${err.message ?? res.statusText}` }],
          isError: true,
        };
      }
      const data = (await res.json()) as { resources: any[] };
      const filtered = kind ? data.resources.filter((r: any) => r.kind === kind) : data.resources;
      return { content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] };
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/resources`, {
        method: "POST",
        headers: cpHeaders(apiKey),
        body: JSON.stringify({ kind, name }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${data.message ?? res.statusText}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/projects/${projectSlug}/bindings`, {
        method: "POST",
        headers: cpHeaders(apiKey),
        body: JSON.stringify({ resourceId, bindingName }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${data.message ?? res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Attached resource ${resourceId} → ${projectSlug} as env.${bindingName}`,
          },
        ],
      };
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/projects/${projectSlug}/bindings/${bindingName}`, {
        method: "DELETE",
        headers: cpHeaders(apiKey),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ message: res.statusText }))) as any;
        return {
          content: [{ type: "text" as const, text: `Failed: ${data.message ?? res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text" as const, text: `Detached env.${bindingName} from ${projectSlug}` },
        ],
      };
    },
  );

  server.tool(
    "delete_resource",
    "Delete a team-owned resource. Fails if any project still has a binding to it — detach first. Authenticate the MCP HTTP request with Authorization: Bearer <key> or x-api-key.",
    {
      resourceId: z.string().describe("Resource ID"),
    },
    async ({ resourceId }) => {
      const apiKey = requireKey();
      if (!apiKey) return missingKeyResult();
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/resources/${resourceId}`, {
        method: "DELETE",
        headers: cpHeaders(apiKey),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${data.message ?? res.statusText}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: `Deleted resource ${resourceId}` }] };
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/resources/${resourceId}`, {
        method: "PATCH",
        headers: cpHeaders(apiKey),
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${data.message ?? res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Renamed resource ${resourceId} → "${name}"` }],
      };
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
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/resources/${resourceId}/query`, {
        method: "POST",
        headers: cpHeaders(apiKey),
        body: JSON.stringify({ sql, params: params ?? [] }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        return {
          content: [
            { type: "text" as const, text: `Query failed: ${data.message ?? res.statusText}` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
    ...(!proof.ok ? { error: "verify_failed" } : extra),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(!proof.ok ? { isError: true as const } : {}),
  };
}

async function pollStatus(statusUrl: string, maxWait = 30_000): Promise<any> {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const res = await fetch(statusUrl);
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

    const status = (await res.json()) as any;
    if (status.status === "active") return status;
    if (status.status === "failed")
      throw new Error(`Deploy failed: ${status.errorMessage ?? "Unknown"}`);
    if (status.status === "expired") throw new Error("Sandbox expired before activation");

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Deploy timed out");
}
