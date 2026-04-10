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
| `packages/cli` | `@solcreek/cli` | CLI implementation: deploy, dev, init, login, claim, domains, env, status, deployments, ops, projects, rollback, whoami |
| `packages/creek` | `creek` | User-facing umbrella package — re-exports `@solcreek/cli` (binaries: `creek`, `ck`, `crk`) and `@solcreek/runtime` (subpaths: `/react`, `/hono`) |
| `packages/runtime` | `@solcreek/runtime` | Runtime bindings (db, kv, storage, ai). Subpath exports: `/react`, `/hono` |
| `packages/ui` | `@solcreek/ui` | Shared UI components (shadcn + Tailwind 4) |
| `packages/create-creek-app` | `create-creek-app` | Template scaffolder CLI |

> **Next.js adapter lives in a sibling repo, not in this monorepo.**
> Source: [`solcreek/adapter-creek`](https://github.com/solcreek/adapter-creek), package `@solcreek/adapter-creek`.
> The CLI's `buildNextjs()` (`packages/cli/src/utils/nextjs.ts`) resolves it via `require.resolve("@solcreek/adapter-creek")` and invokes `next build --webpack` with `NEXT_ADAPTER_PATH` for Next.js >= 16.2.
> An older `packages/adapter-nextjs` directory was removed — do not re-add it.

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
- `apps/www` — creek.dev marketing site (Next.js 16.2 on CF Workers).
  Currently deployed via OpenNextJS (`apps/www/scripts/deploy.sh`) **as an interim workaround** — see [solcreek/creek#1](https://github.com/solcreek/creek/issues/1). The end state is `creek deploy --yes` driven by `@solcreek/adapter-creek`. OpenNextJS dependency, the standalone symlink, and the middleware-manifest patch are all temporary; do not invest in OpenNextJS-side fixes here, fix them in adapter-creek instead.
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
`packages/control-plane/src/modules/` contains 11 domain modules: audit, deployments, domains, env, github, projects, realtime, resources, templates, tenant, web-deploy. Each module has routes, services, and types. Framework: Hono + Better Auth + Drizzle ORM + D1.

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
- **Next.js >= 16.2.3** is required by `@solcreek/adapter-creek` (CVE-2026-23869). When `apps/www` switches off OpenNextJS, bump its `next` dep to `^16.2.3`.
- `packages/cli/src/utils/nextjs.ts` has stale comments referring to `@solcreek/adapter-nextjs`; the resolved package is `@solcreek/adapter-creek`. Code is correct, comments are not — update when touched.
- `packages/deploy-core` exports raw TypeScript (no build step) — consumers bundle it themselves.
- `packages/build-container` bundles to a single `dist/server.mjs` via esbuild. The `@solcreek/sdk` dependency is inlined; `ajv` is also inlined. Only `node:*` builtins are external.
- `turbo build` runs dependency builds first (`^build`). Tests also depend on `^build`. Dev and test tasks are not cached.
