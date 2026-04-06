# Creek

**Deploy to the edge in seconds. No account required.**

[![npm](https://img.shields.io/npm/v/creek/alpha?label=creek&color=blue)](https://www.npmjs.com/package/creek)
[![SDK](https://img.shields.io/npm/v/@solcreek/sdk/alpha?label=sdk&color=blue)](https://www.npmjs.com/package/@solcreek/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)

```bash
npx creek deploy --demo
```

```
  Deploying demo site...
  Live in 8.3s -> https://a1b2c3d4.creeksandbox.com
```

---

## What is Creek

Creek is an open-source deployment platform built entirely on [Cloudflare Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/). One command deploys your site to 300+ edge locations worldwide.

- **Zero friction** -- deploy without an account, get a live URL in seconds
- **Agent-first** -- structured JSON output, no CAPTCHAs, MCP-ready
- **Cloudflare-native** -- runs on Workers, D1, R2, and KV with no abstraction tax

## Quickstart

### See it in action (no account needed)

```bash
npx creek deploy --demo
```

### Deploy your project

```bash
cd my-vite-app
npx creek deploy
```

Creek auto-detects your framework, runs the build, and deploys to a sandbox preview (60 min).

### Deploy a directory

```bash
npx creek deploy ./dist
```

Already built? Point Creek at any directory of static files.

## Features

| Feature | Description |
|---------|-------------|
| **10-second deploys** | From CLI to live URL on Cloudflare's global edge |
| **Zero-config** | Auto-detects React, Vue, Svelte, Astro, and more |
| **No account required** | Sandbox deploys work without signup or authentication |
| **Agent-optimized** | `--json` output, structured API, no interactive prompts in CI |
| **Framework detection** | Vite, Next.js, SvelteKit, Nuxt, Astro, Solid, TanStack Start |
| **SSR support** | Server-side rendering on Workers via Static Assets API |
| **Content scanning** | Phishing and abuse detection on sandbox deploys |
| **Open source** | Apache 2.0 -- self-host on your own Cloudflare account |

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

Apache 2.0 -- see [LICENSE](LICENSE).

Commercial features (analytics, advanced abuse detection, SSO) are available under a separate license in `/ee`.

---

Built by [SolCreek](https://creek.dev).
