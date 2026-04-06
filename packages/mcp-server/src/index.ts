import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./types.js";
import { registerTools } from "./tools.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*" }));

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "creek-mcp-server" }));

// MCP endpoint — Streamable HTTP transport
app.all("/mcp", async (c) => {
  // MCP SDK requires a new server instance per request
  const server = new McpServer({
    name: "creek",
    version: "1.0.0",
  });

  const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
  registerTools(server, { env: c.env, clientIp });

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true, // stateless — JSON responses, no SSE streaming needed
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    return c.json(
      { error: "mcp_error", message: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

// SSE endpoint for clients that prefer Server-Sent Events
app.get("/sse", async (c) => {
  // Redirect to /mcp — StreamableHTTPServerTransport handles both
  return c.redirect("/mcp", 301);
});

// Catch-all
app.notFound((c) =>
  c.json({
    error: "not_found",
    message: "Creek MCP Server. Connect to /mcp using an MCP client.",
    docs: "https://creek.dev/docs/mcp",
  }, 404),
);

app.onError((err, c) =>
  c.json({ error: "internal", message: err.message }, 500),
);

export default app;
