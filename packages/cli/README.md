# creek

Deploy to the edge in seconds. No account required.

[![npm](https://img.shields.io/npm/v/creek?color=blue)](https://www.npmjs.com/package/creek)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](https://github.com/solcreek/creek/blob/main/LICENSE)

```bash
npx creek deploy --template landing
# Live in 8.3s -> https://a1b2c3d4.creeksandbox.com
```

Creek is the CLI for the [Creek deployment platform](https://creek.dev) -- an open-source, Cloudflare-native alternative to Vercel. Built on [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/).

Also available as `ck` and `crk`.

## Install

```bash
npm install -g creek
```

Or use directly with `npx`:

```bash
npx creek deploy
```

## Quick Start

### Start from a template (no account needed)

```bash
creek deploy --template landing
```

Clones a ready-made Vite + React landing page, builds it, and deploys it to a 60-minute sandbox URL — all in one command. The code is yours to edit.

### Deploy your project

```bash
cd my-vite-app
creek deploy
```

Creek auto-detects your framework, runs the build, and deploys to a sandbox preview (60 min).

### Deploy a directory

```bash
creek deploy ./dist
```

### Deploy from a repo URL

```bash
creek deploy https://github.com/user/repo
creek deploy https://github.com/user/repo/tree/main/packages/app
```

## Commands

| Command | Description |
|---------|-------------|
| `creek deploy [dir]` | Deploy project, directory, or repo URL |
| `creek deploy --template <name>` | Clone + build + deploy a named template |
| `creek deploy --dry-run` | Show the deploy plan without executing (agent-safe) |
| `creek projects` | List your projects |
| `creek deployments` | List deployments for a project |
| `creek logs` | Read recent log entries (R2 archive) |
| `creek logs --follow` | Live tail via WebSocket until Ctrl+C |
| `creek logs --outcome exception` | Filter by tail outcome (or `--deployment`, `--branch`, `--level`, `--search`) |
| `creek status` | Show current project status |
| `creek login` | Authenticate with Creek |
| `creek login --token <key>` | Authenticate in CI/CD (non-interactive) |
| `creek init` | Create `creek.toml` configuration |
| `creek claim <id>` | Convert sandbox preview to permanent project |
| `creek env set <key> <val>` | Set an environment variable |
| `creek env ls` | List environment variables |
| `creek env rm <key>` | Remove an environment variable |
| `creek whoami` | Show current authenticated user |

## Global Flags

Every command supports these flags:

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON (auto-enabled in non-TTY environments) |
| `--yes` | Skip confirmation prompts (auto-enabled in non-TTY environments) |

## For AI Agents

Creek is designed for programmatic use. No CAPTCHAs, no interactive prompts in CI.

### Structured output

```bash
creek deploy ./dist --json
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

### Non-TTY auto-detection

When running in pipes, CI/CD, or agent environments (no TTY), the CLI automatically:
- Outputs JSON instead of human-readable text
- Skips all confirmation prompts
- Uses exit codes for success (0) and failure (1)

```bash
# These are equivalent in CI:
creek deploy ./dist --json --yes
creek deploy ./dist  # auto-detects non-TTY
```

### MCP Server

Creek provides a remote MCP server at `mcp.creek.dev` for AI agent integration. See the [MCP documentation](https://creek.dev/docs/mcp) for details.

### HTTP API

Deploy without installing the CLI:

```bash
curl -X POST https://sandbox-api.creek.dev/api/sandbox/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "assets": { "index.html": "<base64>" },
    "source": "my-agent"
  }'
```

No API key required for sandbox deploys. See the [API documentation](https://creek.dev/docs/api) for details.

## Supported Frameworks

Creek auto-detects and configures the build for:

- Next.js
- Vite (React, Vue, Svelte, Solid)
- Astro
- SvelteKit
- Nuxt
- TanStack Start
- React Router
- Any static site

## Deploy Modes

| Mode | Trigger | Auth Required | TTL |
|------|---------|:-------------:|-----|
| **Template** | `--template <name>` | No | 60 min |
| **Sandbox** | No `creek.toml` | No | 60 min |
| **Production** | Has `creek.toml` + token | Yes | Permanent |

## Configuration

Create `creek.toml` with `creek init`, or skip it entirely -- Creek works with zero config.

```toml
[project]
name = "my-app"
framework = "vite-react"

[build]
command = "npm run build"
output = "dist"
```

## Links

- [Creek](https://creek.dev) -- Platform homepage
- [Documentation](https://creek.dev/docs) -- Guides and reference
- [GitHub](https://github.com/solcreek/creek) -- Source code
- [MCP Server](https://creek.dev/docs/mcp) -- AI agent integration

## License

Apache 2.0 -- see [LICENSE](https://github.com/solcreek/creek/blob/main/LICENSE).
