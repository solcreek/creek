# Creek

**Open-source deployment platform built on Cloudflare Workers.**

[![npm](https://img.shields.io/npm/v/creek?label=creek&color=blue)](https://www.npmjs.com/package/creek)
[![SDK](https://img.shields.io/npm/v/@solcreek/sdk?label=sdk&color=blue)](https://www.npmjs.com/package/@solcreek/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)

One command deploys your full-stack app — frontend, SSR, database, cron, queue — to 300+ Cloudflare locations worldwide. Self-host on your own account, or use Creek Cloud.

```bash
npx creek deploy
```

---

## What you get

- **One-command deploys** — auto-detects your framework, builds, and deploys
- **Built-in resources** — D1 database, R2 storage, KV cache, AI, Queues — provisioned per project
- **Cron + Queue triggers** — declare in `creek.toml`, Creek wires everything up
- **Realtime sync** — D1 writes auto-broadcast to connected clients via WebSocket
- **Per-tenant analytics** — requests, errors, latency, cron execution log
- **Agent-first** — JSON output, breadcrumb hints, MCP server, no CAPTCHAs
- **Open source** — Apache 2.0, self-host on your own Cloudflare account

---

## Zero config, one command

```bash
cd my-vite-app
npx creek deploy
#  Detected: creek.toml (Vite + React + D1 + KV)
#  Building...
#  Deploying to edge...
#  ⬡ Deployed! https://my-vite-app-myteam.bycreek.com
```

Creek detects your framework, provisions resources, builds, and deploys.

**Supported:** React · Vue · Svelte · Solid · Astro · Hono · TanStack Start · React Router · static HTML
**WIP:** Next.js · Nuxt · Remix · SvelteKit

---

## Features

### Realtime in 6 lines

WebSocket sync, optimistic updates, multi-user rooms. Zero boilerplate.

```typescript
// Server
import { db } from "creek";
import { room } from "creek/hono";

app.use("/api/*", room());

app.post("/api/todos", async (c) => {
  // db.mutate() auto-broadcasts to all connected clients
  await db.mutate("INSERT INTO todos (room_id, text) VALUES (?, ?)",
    c.var.room, await c.req.json().then(b => b.text));
  return c.json({ ok: true });
});
```

```tsx
// Client
import { LiveRoom, useLiveQuery } from "creek/react";

function App() {
  const { data: todos, mutate } = useLiveQuery("/api/todos");
  // Auto-refetches when data changes. Optimistic updates with auto-rollback.
}
```

### Cron + Queue triggers

```toml
# creek.toml
[project]
name = "my-app"

[resources]
database = true

[triggers]
cron = ["0 */6 * * *"]   # Every 6 hours
queue = true              # Auto-provisions a CF Queue
```

```typescript
// worker/index.ts
import { db, queue } from "creek";

export default {
  async fetch(request, env) {
    await queue.send({ type: "process", id: "123" });
    return new Response("queued");
  },
  async scheduled(event, env, ctx) {
    // Runs every 6 hours
    await db.prepare("DELETE FROM stale WHERE created < ?").bind(Date.now() - 86400000).run();
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      // Process message
    }
  },
};
```

### Per-tenant analytics

Built-in dashboard shows requests, errors, CPU latency (p50/p99) for the last 24h / 7d / 30d. Cron execution log included.

### Built-in resources

```toml
[resources]
database = true   # D1 (SQLite at the edge)
storage = true    # R2 (object storage, zero egress)
cache = true      # KV (key-value)
ai = true         # Workers AI
```

Creek provisions per-tenant resources via the Cloudflare API. Each project gets its own isolated D1 database, R2 bucket, KV namespace.

---

## Built for AI agents

```bash
# JSON output auto-enabled in non-TTY / CI
npx creek deploy --json
```

```json
{
  "ok": true,
  "url": "https://my-app-myteam.bycreek.com",
  "deploymentId": "a1b2c3d4-...",
  "cron": ["0 */6 * * *"],
  "breadcrumbs": [
    { "command": "creek status", "description": "Check deployment status" }
  ]
}
```

- **No CAPTCHAs** — [Agent Challenge](https://creek.dev/docs/api#agent-challenge) for verified agent tokens
- **Breadcrumb hints** in error responses guide agents to next steps
- **MCP server** at `mcp.creek.dev` (in development) — any AI agent can deploy with a single tool call

---

## Open source

Apache 2.0 licensed. The entire platform is open source — CLI, control plane, dashboard, runtime, sandbox, dispatch worker.

Self-host on your own Cloudflare account, or use [Creek Cloud](https://creek.dev) (managed).

```bash
git clone https://github.com/solcreek/creek.git
cd creek && pnpm install
# Copy wrangler.*.example → wrangler.*, fill in your CF account
pnpm --filter @solcreek/control-plane deploy
```

Enterprise governance features (SSO, approval workflows, policy engine) will be available under `/ee` in a separate license.

---

## CLI Reference

```
creek deploy [dir]          Deploy project or directory
creek deploy --demo         Deploy a sample site instantly (no auth)
creek deploy --json         Output structured JSON (auto in CI)
creek deploy --skip-build   Deploy without running build step
creek dev                   Local dev server with D1/KV/R2 simulation
creek status                Project status, triggers, deployment info
creek deployments           List deployment history
creek rollback              Rollback to a previous deployment
creek env set <key> <val>   Set an environment variable
creek env ls                List environment variables
creek domains add <host>    Add a custom domain
creek login                 Authenticate with Creek
creek init                  Create creek.toml configuration
creek claim <sandboxId>     Convert sandbox preview to permanent project
```

---

## How it works

```
                 CLI / API / MCP
                       |
          +------------+------------+
          |                         |
    Sandbox API               Control Plane
   (no auth, 60min)         (auth, permanent)
          |                         |
          +------------+------------+
                       |
            Workers for Platforms
           (dispatch namespace)
                       |
              +--------+--------+
              |        |        |
           Worker   Static    D1/R2/KV/Queue
           Script   Assets    (per-tenant)
                       |
                Cloudflare Edge
               (300+ locations)
```

**Sandbox path:** `creek deploy --demo` → Sandbox API → live URL (60 min, no auth)
**Production path:** `creek deploy` → Control Plane → permanent URL + custom domain

---

## Project structure

```
creek/
  apps/
    dashboard/              Vite + React + TanStack Router (app.creek.dev)
    www/                    Next.js marketing site (creek.dev)
  packages/
    cli/                    CLI — npm: creek
    sdk/                    TypeScript SDK — npm: @solcreek/sdk
    runtime/                creek runtime for deployed apps — npm: @solcreek/runtime
    deploy-core/            Shared WfP deployment logic
    control-plane/          Hono API + Better Auth + D1 (api.creek.dev)
    sandbox-api/            Public sandbox deploy API
    sandbox-dispatch/       Sandbox routing + banner injection
    dispatch-worker/        Production tenant routing
    realtime-worker/        WebSocket via Durable Objects
    remote-builder/         CF Containers remote build orchestrator
    build-container/        Build environment Docker image
    ui/                     Shared UI (shadcn v4 + Base UI)
    create-creek-app/       Template scaffolder — npm: create-creek-app
    mcp-server/             MCP server (mcp.creek.dev)
  infra/                    OpenTofu (Cloudflare resources)
```

---

## Tech stack

- **Runtime:** Cloudflare Workers
- **Framework:** Hono (API), Vite + React (dashboard), Next.js (www)
- **Database:** Cloudflare D1 (SQLite) + Drizzle ORM
- **Storage:** Cloudflare R2
- **Queue:** Cloudflare Queues
- **Auth:** Better Auth (GitHub, Google, email/password, API keys)
- **Multi-tenancy:** Workers for Platforms (dispatch namespaces)
- **IaC:** OpenTofu (Cloudflare provider)
- **Monorepo:** pnpm workspaces + Turborepo
- **Testing:** Vitest (790+ tests)

---

## Self-hosting

Creek is designed to run entirely on a single Cloudflare account.

**Prerequisites**
- Cloudflare account with Workers for Platforms enabled
- Node.js >= 18, pnpm >= 9
- OpenTofu (for infrastructure management)

```bash
git clone https://github.com/solcreek/creek.git
cd creek
pnpm install

# Deploy infrastructure
cd infra && tofu init && tofu apply

# Deploy workers
pnpm --filter @solcreek/control-plane deploy
pnpm --filter @solcreek/sandbox-api deploy
pnpm --filter @solcreek/sandbox-dispatch deploy
pnpm --filter @solcreek/dispatch-worker deploy
```

See [Self-Hosting Guide](https://creek.dev/docs/self-hosting) for detailed instructions.

---

## Development

```bash
pnpm install
pnpm test            # Run all tests (790+)
pnpm typecheck       # TypeScript checks across all packages
pnpm dev             # Start all dev servers
```

---

## Contributing

We welcome contributions. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- **Issues:** [github.com/solcreek/creek/issues](https://github.com/solcreek/creek/issues)
- **Discussions:** [github.com/solcreek/creek/discussions](https://github.com/solcreek/creek/discussions)

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

**[creek.dev](https://creek.dev)** · **[Docs](https://creek.dev/docs)** · **[Templates](https://templates.creek.dev)** · **[Discord](https://discord.gg/creek)**

Built by [SolCreek](https://creek.dev).
