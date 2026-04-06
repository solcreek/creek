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
