/**
 * Creek MCP Tools — protocol translator layer.
 *
 * Each tool maps to an existing Creek API endpoint.
 * No business logic here — just translate MCP tool calls to HTTP requests.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./types.js";

export interface ToolContext {
  env: Env;
  clientIp: string;
}

export function registerTools(server: McpServer, ctx: ToolContext) {
  const { env, clientIp } = ctx;

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
      source: z.string().optional().describe("Source identifier for tracking (e.g. 'cursor', 'claude')"),
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
        const err = await res.json().catch(() => ({ message: res.statusText })) as any;
        return { content: [{ type: "text" as const, text: `Deploy failed: ${err.message ?? res.statusText}` }], isError: true };
      }

      const deploy = await res.json() as any;

      // Poll for active status
      const status = await pollStatus(deploy.statusUrl);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            url: status.previewUrl,
            sandboxId: status.sandboxId,
            deployDurationMs: status.deployDurationMs,
            expiresAt: status.expiresAt,
            expiresInSeconds: status.expiresInSeconds,
          }, null, 2),
        }],
      };
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
        const err = await res.json().catch(() => ({ message: res.statusText })) as any;
        return { content: [{ type: "text" as const, text: `Demo deploy failed: ${err.message}` }], isError: true };
      }

      const deploy = await res.json() as any;
      const status = await pollStatus(deploy.statusUrl);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            url: status.previewUrl,
            sandboxId: status.sandboxId,
            deployDurationMs: status.deployDurationMs,
            message: "Demo deployed successfully. Visit the URL to see it live.",
          }, null, 2),
        }],
      };
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
        return { content: [{ type: "text" as const, text: `Sandbox ${sandboxId} not found` }], isError: true };
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
        const err = await res.json().catch(() => ({ message: res.statusText })) as any;
        return { content: [{ type: "text" as const, text: `Delete failed: ${err.message}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: `Sandbox ${sandboxId} deleted.` }] };
    },
  );

  // ================================================================
  // Tier 2: Authenticated (Creek account) — agent passes a Creek API key
  // ================================================================

  server.tool(
    "get_build_log",
    "Read the structured build log for a deployment. Use this after `creek deploy` reports a failure to see exactly which phase broke, what the subprocess stderr was, and the CK-* diagnostic code. Returns a summary (status, failing step, error code) plus phase-grouped lines. Requires a Creek API key (obtain via `creek login`).",
    {
      apiKey: z
        .string()
        .describe(
          "Creek API key. Users should run `creek login` then copy the stored token; CLI-first agents can read ~/.creek/config.json.",
        ),
      projectSlug: z.string().describe("Project slug (shown by `creek projects` or `creek status`)"),
      deploymentId: z.string().describe("Deployment id (8-char short id or full uuid)"),
    },
    async ({ apiKey, projectSlug, deploymentId }) => {
      const base = env.CONTROL_PLANE_URL.replace(/\/$/, "");
      // Resolve short id → full id if needed. GET /logs requires full uuid.
      let fullId = deploymentId;
      if (fullId.length < 36) {
        const listRes = await fetch(`${base}/projects/${projectSlug}/deployments`, {
          headers: { "x-api-key": apiKey },
        });
        if (!listRes.ok) {
          const err = await listRes.json().catch(() => ({ message: listRes.statusText })) as { message?: string };
          return {
            content: [{ type: "text" as const, text: `Lookup failed: ${err.message ?? listRes.statusText}` }],
            isError: true,
          };
        }
        const list = (await listRes.json()) as Array<{ id: string }>;
        const match = list.find((d) => d.id.startsWith(fullId));
        if (!match) {
          return {
            content: [{ type: "text" as const, text: `No deployment matches id prefix '${fullId}' in project '${projectSlug}'.` }],
            isError: true,
          };
        }
        fullId = match.id;
      }

      const res = await fetch(
        `${base}/projects/${projectSlug}/deployments/${fullId}/logs`,
        { headers: { "x-api-key": apiKey } },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string; error?: string };
        return {
          content: [{ type: "text" as const, text: `Read failed (${res.status}): ${err.message ?? res.statusText}` }],
          isError: true,
        };
      }

      const log = (await res.json()) as {
        entries: Array<{ ts: number; step: string; stream: string; level: string; msg: string; code?: string }>;
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
            };

      // Show only error / fatal lines + the failing-step lines in the
      // short view — the full log is attached below for follow-up.
      const failing = log.metadata?.errorStep ?? null;
      const importantLines = log.entries.filter(
        (e) =>
          e.level === "error" ||
          e.level === "fatal" ||
          (failing !== null && e.step === failing),
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
}

// ================================================================
// Helpers
// ================================================================

async function pollStatus(statusUrl: string, maxWait = 30_000): Promise<any> {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const res = await fetch(statusUrl);
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

    const status = await res.json() as any;
    if (status.status === "active") return status;
    if (status.status === "failed") throw new Error(`Deploy failed: ${status.errorMessage ?? "Unknown"}`);
    if (status.status === "expired") throw new Error("Sandbox expired before activation");

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Deploy timed out");
}
