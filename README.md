# Creek

**Deploy to the edge. Realtime built in.**

[![npm](https://img.shields.io/npm/v/creek/alpha?label=creek&color=blue)](https://www.npmjs.com/package/creek)
[![SDK](https://img.shields.io/npm/v/@solcreek/sdk/alpha?label=sdk&color=blue)](https://www.npmjs.com/package/@solcreek/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)

Creek is an open-source deployment platform on [Cloudflare Workers](https://workers.cloudflare.com/). One command deploys your full-stack app — with database, realtime sync, and edge performance — to 300+ locations worldwide.

```bash
npx creek deploy
```

---

## Realtime in 6 lines

WebSocket sync, optimistic updates, multi-user rooms. Zero boilerplate.

**Server:**
```typescript
import { db } from "creek";
import { room } from "creek/hono";

app.use("/api/*", room());

app.post("/api/todos", async (c) => {
  const { text } = await c.req.json();
  // db.mutate() auto-broadcasts to all connected clients. No WebSocket code.
  await db.mutate(
    "INSERT INTO todos (room_id, text) VALUES (?, ?)",
    c.var.room, text
  );
  return c.json({ ok: true });
});
```

**Client:**
```tsx
import { LiveRoom, useLiveQuery } from "creek/react";

function App() {
  return (
    <LiveRoom id={roomId}>
      <TodoApp />
    </LiveRoom>
  );
}

function TodoApp() {
  // useLiveQuery auto-refetches when data changes. Optimistic updates with auto-rollback.
  const { data: todos, mutate } = useLiveQuery("/api/todos");

  const addTodo = (text) =>
    mutate(
      { method: "POST", path: "/api/todos", body: { text } },
      (prev) => [{ text, completed: 0 }, ...prev],  // optimistic
    );
}
```

**Config:**
```toml
[project]
name = "my-app"

[build]
worker = "worker/index.ts"

[resources]
database = true   # Creek provisions the database and realtime service automatically.
```

---

## Zero config

Creek detects your framework, builds your project, and deploys it.
No `creek.toml`, no `wrangler.toml`, no `vercel.json`.

```bash
cd my-vite-app
npx creek deploy
#  Detected: Vite (React)
#  Building...
#  Deploying to edge...
#  Live → https://my-vite-app-myteam.bycreek.com
```

Supports: **React** · **Vue** · **Svelte** · **Astro** · **Solid** · **Hono** · **TanStack Start** · static HTML · Next.js (WIP) · Nuxt (WIP) · Remix (WIP)

---

## Built for AI agents

The only deployment platform with a remote MCP server.
Any AI agent can deploy with a single tool call, zero installation.

```json
{
  "mcpServers": {
    "creek": { "url": "https://mcp.creek.dev/mcp" }
  }
}
```

Agent-friendly by default:
- `--json` output auto-enabled in non-TTY / CI
- No CAPTCHAs — [Agent Challenge](https://creek.dev/docs/api#agent-challenge) for verified agent tokens
- Breadcrumb hints in error responses guide agents to next steps

---

## Edge-native performance

Every deploy runs on Cloudflare's global edge — 300+ locations, millisecond cold starts.

- **Per-tenant V8 isolate isolation** via Workers for Platforms
- **Built-in database** (D1), object storage (R2), key-value (KV)
- **Zero egress fees** — unlimited bandwidth on paid plans
- **SSR at the edge** — framework SSR on Workers (Next.js, Nuxt, SvelteKit — WIP)

---

## Open source

Apache 2.0 licensed. Self-host on your own Cloudflare account. No vendor lock-in.

```bash
git clone https://github.com/solcreek/creek.git
cd creek && pnpm install
# Copy wrangler.toml.example → wrangler.toml, fill in your CF account
pnpm --filter @solcreek/control-plane deploy
```

The entire platform is open-source — CLI, control plane, dashboard, realtime, sandbox.
Creek Cloud adds multi-tenant operations, billing, and abuse detection.

---

## Quickstart

```bash
# See it in action (no account needed)
npx creek deploy --demo

# Deploy your project
cd my-vite-app
npx creek deploy

# Deploy a directory
npx creek deploy ./dist
```

## How It Works

```
                  CLI / API / MCP
                       |
          +------------+------------+
          |                         |
    Sandbox API               Control Plane
   (no auth, 60 min)        (auth, permanent)
          |                         |
          +------------+------------+
                       |
            Workers for Platforms
           (dispatch namespace)
                       |
              +--------+--------+
              |        |        |
           Worker   Static    D1/R2/KV
           Script   Assets    (per-tenant)
              |        |
              +--------+
                  |
            Cloudflare Edge
           (300+ locations)
```

**Sandbox path:** `creek deploy` -> Sandbox API -> WfP -> live URL (no auth)
**Production path:** `creek deploy` (with `creek.toml`) -> Control Plane -> WfP -> live URL (permanent)

## CLI Reference

```
creek deploy [dir]          Deploy project or directory
creek deploy --demo         Deploy a sample site instantly
creek deploy --json         Output structured JSON (auto-enabled in CI)
creek deploy --skip-build   Deploy without running build step
creek login                 Authenticate with Creek
creek login --headless      Paste API key manually (for SSH/remote)
creek init                  Create creek.toml configuration
creek claim <sandboxId>     Convert sandbox preview to permanent project
creek env set <key> <val>   Set an environment variable
creek env ls                List environment variables
creek env rm <key>          Remove an environment variable
creek whoami                Show current authenticated user
```

## For AI Agents

Creek is designed for programmatic use. Every deploy path works without human interaction.

### CLI (with --json)

```bash
npx creek deploy ./dist --json
```

```json
{
  "ok": true,
  "sandboxId": "a1b2c3d4",
  "url": "https://a1b2c3d4.creeksandbox.com",
  "deployDurationMs": 9234,
  "expiresAt": "2026-03-27T16:00:00.000Z",
  "assetCount": 12,
  "mode": "sandbox"
}
```

Non-TTY environments (pipes, CI, agents) automatically use JSON output.

### HTTP API

```bash
curl -X POST https://sandbox-api.creek.dev/api/sandbox/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "assets": {
      "index.html": "<base64-encoded-content>"
    },
    "source": "my-agent"
  }'
```

No API key required for sandbox deploys. Rate limit: 10/hr (demo deploys exempt).

### MCP Server (planned)

```json
{
  "mcpServers": {
    "creek": {
      "url": "https://mcp.creek.dev/sse"
    }
  }
}
```

Remote MCP server -- any AI agent can deploy with a single tool call, zero installation.

## Project Structure

```
creek/
  apps/
    dashboard/              Vite + React + TanStack Router
    www/                    Next.js marketing site
  packages/
    cli/                    CLI (citty + consola) -- npm: creek
    sdk/                    TypeScript SDK -- npm: @solcreek/sdk
    deploy-core/            Shared WfP deployment logic
    control-plane/          Hono API + Better Auth + D1
    sandbox-api/            Public sandbox deploy API
    sandbox-dispatch/       Sandbox routing + banner injection
    dispatch-worker/        Production tenant routing
    realtime-worker/        WebSocket via Durable Objects
    runtime/                creek package for deployed apps
    ui/                     Shared UI (shadcn + base-ui)
  infra/                    OpenTofu (Cloudflare resources)
```

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Framework:** Hono (API), Vite + React (dashboard), Next.js (www)
- **Database:** Cloudflare D1 (SQLite) + Drizzle ORM
- **Storage:** Cloudflare R2
- **Auth:** Better Auth (GitHub, Google, email/password, API keys)
- **Multi-tenancy:** Workers for Platforms (dispatch namespaces)
- **IaC:** OpenTofu (Cloudflare provider)
- **Monorepo:** pnpm workspaces + Turborepo
- **Testing:** Vitest

## Self-Hosting

Creek is designed to run entirely on a single Cloudflare account.

### Prerequisites

- Cloudflare account with Workers for Platforms enabled
- Node.js >= 18, pnpm >= 9
- OpenTofu (for infrastructure management)

### Setup

```bash
git clone https://github.com/solcreek/creek.git
cd creek
pnpm install

# Deploy infrastructure
cd infra
tofu init && tofu apply

# Deploy workers
pnpm --filter @solcreek/control-plane deploy
pnpm --filter @solcreek/sandbox-api deploy
pnpm --filter @solcreek/sandbox-dispatch deploy
pnpm --filter @solcreek/dispatch-worker deploy
```

See [Self-Hosting Guide](https://creek.dev/docs/self-hosting) for detailed instructions.

## Development

```bash
pnpm install
pnpm test            # Run all tests
pnpm typecheck       # TypeScript checks across all packages
pnpm dev             # Start all dev servers
```

## Contributing

We welcome contributions. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- **Issues:** [github.com/solcreek/creek/issues](https://github.com/solcreek/creek/issues)
- **Discussions:** [github.com/solcreek/creek/discussions](https://github.com/solcreek/creek/discussions)

## License

Apache 2.0 — see [LICENSE](LICENSE).

Enterprise governance features (SSO, approval workflows, policy engine) will be available under a separate license in `/ee`.

---

**[creek.dev](https://creek.dev)** · **[Docs](https://creek.dev/docs)** · **[Templates](https://templates.creek.dev)** · **[Discord](https://discord.gg/creek)**

Built by [SolCreek](https://creek.dev).
