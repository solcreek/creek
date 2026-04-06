# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
pnpm build              # Build all packages (turbo, dependency-aware)
pnpm dev                # Start dev servers (persistent)
pnpm test               # Run all tests (vitest run)
pnpm test:watch         # Watch mode
pnpm typecheck          # Type-check all packages
pnpm lint               # Lint (currently only apps/www)
pnpm clean              # Clean all dist/ outputs

# Single test file
pnpm vitest run packages/sdk/src/config/resolved-config.test.ts

# Single package build
pnpm --filter @solcreek/sdk build
```

Tests live alongside source as `*.test.ts` files. Type-level tests use `*.test-d.ts`. Vitest globals are enabled (no imports needed for `describe`, `it`, `expect`).

## Monorepo Structure

**pnpm workspaces** + **Turborepo**. All inter-package deps use `workspace:*`.

### Published Packages (npm)
| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/sdk` | `@solcreek/sdk` | Config detection, framework detection, wrangler parsing, bindings extraction |
| `packages/cli` | `creek` | CLI: deploy, dev, init, login, claim, domains, env, status |
| `packages/runtime` | `@solcreek/runtime` | Runtime bindings (db, kv, storage, ai). Subpath exports: `/react`, `/hono` |
| `packages/adapter-nextjs` | `@solcreek/adapter-nextjs` | Next.js 16.2+ adapter for CF Workers |
| `packages/ui` | `@solcreek/ui` | Shared UI components (shadcn + Tailwind 4) |
| `packages/create-creek-app` | `create-creek-app` | Template scaffolder CLI |

### Cloudflare Workers (deployed, not published)
| Package | Service | Domain |
|---------|---------|--------|
| `packages/control-plane` | creek-control-plane | api.creek.dev |
| `packages/sandbox-api` | creek-sandbox-api | sandbox-api.creek.dev |
| `packages/sandbox-dispatch` | creek-sandbox-dispatch | *.creeksandbox.com |
| `packages/dispatch-worker` | creek-dispatch | *.bycreek.com |
| `packages/realtime-worker` | creek-realtime | (WebSocket DO) |
| `packages/deploy-api` | creek-deploy-api | |
| `packages/remote-builder` | creek-remote-builder | |
| `packages/mcp-server` | creek-mcp-server | mcp.creek.dev |

### Apps
- `apps/www` — creek.dev marketing site (Next.js 16.2 on CF Workers via OpenNextJS)
- `apps/dashboard` — app.creek.dev admin dashboard (Vite + React 19 + TanStack Router)

### Internal Packages
- `packages/deploy-core` — CF Static Assets API deployment logic (exports raw TS, not compiled)
- `packages/build-container` — Docker container for remote builds (esbuild-bundled to dist/server.mjs)

## Architecture

### Config Detection Chain (SDK)
The SDK resolves project configuration by checking sources in order:
1. `creek.toml` (Creek-native config)
2. `wrangler.jsonc` → `wrangler.json` → `wrangler.toml` (existing CF projects)
3. `package.json` (framework detection)
4. `index.html` (static site fallback)

Output is `ResolvedConfig` — the canonical representation used by CLI, build-container, and control-plane.

### Build Layers (L1-L5)
- **L1 Protocol** — SDK: ResolvedConfig, wrangler parsing, framework detection
- **L2 Execution** — build-container: git clone, install, build, bundle
- **L3 Orchestration** — remote-builder: container lifecycle via CF Containers + Durable Objects
- **L4 Cache** — R2-based build cache (EE)
- **L5 Intelligence** — repo profiling, auto-instance selection (private)

### Control-Plane Modules
`packages/control-plane/src/modules/` contains 13 domain modules: tenant, audit, deployments, projects, domains, env, github, templates, web-deploy, realtime, resources, db. Each module has routes, services, and types. Framework: Hono + Better Auth + Drizzle ORM + D1.

### Tenant Routing
- Production: `{project}-{team}.bycreek.com` — handled by dispatch-worker
- Sandbox: `{id}.creeksandbox.com` — handled by sandbox-dispatch (60 min TTL, no auth)

### Deploy Paths
1. **CLI**: `creek deploy` — local build → SDK config → deploy-core → CF API
2. **CLI template**: `creek deploy --template landing --data '{...}'` — fetch template → validate schema → build → deploy
3. **Web deploy**: creek.dev/new → API route → remote-builder (service binding) → build-container (CF Container) → sandbox-api
4. **GitHub push**: webhook → control-plane → remote-builder → container build → deploy

## Key Conventions

- **TypeScript**: strict mode, ES2022 target, bundler moduleResolution. Base config in `tsconfig.base.json`.
- **Workers**: all use Hono. Type augmentation via `@cloudflare/workers-types`.
- **Template data**: `creek-template.json` (JSON Schema + metadata, removed after scaffold), `creek-data.json` (runtime config persisted in project).
- **Framework SSR**: pre-bundled server output must NOT be re-bundled. Upload framework build output directly to Workers for Platforms.

## Important Caveats

- `apps/www` uses **Next.js 16.2** which has breaking changes from training data. Always read `node_modules/next/dist/docs/` before modifying Next.js code.
- `packages/deploy-core` exports raw TypeScript (no build step) — consumers bundle it themselves.
- `packages/build-container` bundles to a single `dist/server.mjs` via esbuild. The `@solcreek/sdk` dependency is inlined; `ajv` is also inlined. Only `node:*` builtins are external.
- `turbo build` runs dependency builds first (`^build`). Tests also depend on `^build`. Dev and test tasks are not cached.
