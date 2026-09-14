import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./types.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Authorization",
      "x-api-key",
      "Content-Type",
      "Accept",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
      "Last-Event-ID",
    ],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "creek-mcp-server" }));

// MCP Streamable HTTP. Canonical URL is https://mcp.creek.dev — /mcp is
// kept so existing client configs keep working.
async function handleMcp(c: Context<{ Bindings: Env }>) {
  const server = new McpServer({
    name: "creek",
    version: "1.0.0",
  });

  const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
  registerTools(server, { env: c.env, clientIp, requestHeaders: c.req.raw.headers });
  registerResources(server);

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
}

app.all("/", (c) => handleMcp(c));
app.all("/mcp", (c) => handleMcp(c));

app.get("/sse", (c) => c.redirect("/", 301));

// Catch-all
app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      message: "Creek MCP Server. Connect to https://mcp.creek.dev using an MCP client.",
      docs: "https://creek.dev/docs/mcp",
    },
    404,
  ),
);

app.onError((err, c) => c.json({ error: "internal", message: err.message }, 500));

export default app;
