# Creek capabilities

A one-page index of what Creek can do today and where each capability
lives across the runtime SDK, `creek.toml`, CLI, MCP server, dashboard,
and agent skills.

See [Getting Started](https://creek.dev/docs/getting-started) for
tutorials, or browse each row's docs link below.

---

## Frameworks

Creek is **Vite-first**. The zero-config detection chain is designed
for Vite apps and meta-frameworks built on top of Vite.

| Framework | Tier | Notes |
|---|---|---|
| Vite + React | ✓ zero-config | `vite.config.*` auto-detected |
| Vite + Vue | ✓ zero-config | |
| Vite + Svelte | ✓ zero-config | |
| Vite + Solid | ✓ zero-config | |
| Astro | ✓ zero-config | Vite underneath |
| SvelteKit | 🧪 experimental SSR | Vite underneath |
| Nuxt | 🧪 experimental SSR | Vite underneath |
| TanStack Start | ✓ zero-config | |
| React Router (v7 / Remix) | ✓ | |
| Hono | ✓ | |
| Static site (`index.html`) | ✓ | fallback detection |
| Next.js | ✓ SSR + static | via [`@solcreek/adapter-creek`](https://github.com/solcreek/adapter-creek) — custom adapter with Node.js API shims, streaming SSR, embedded manifests. Requires Next.js >= 16.2.3. |

The two "experimental SSR" entries (SvelteKit, Nuxt) work for SPA /
islands mode today; full server build is WIP. Vite SPA detection is
the most mature tier because the `resolveConfig` chain was designed
against it first.

---

## Runtime — `import from 'creek'`

Code-level APIs exposed by [`@solcreek/runtime`](packages/runtime). These
run inside your Worker, reachable via the `env` bindings Creek
auto-provisions at deploy time.

| Capability | API | `creek.toml` | Docs |
|---|---|---|---|
| Database (D1) | `import { db } from 'creek'` | `database = true` | [/docs/runtime/database](https://creek.dev/docs/runtime/database) |
| Storage (R2) | `import { storage } from 'creek'` | `storage = true` | [/docs/runtime/storage](https://creek.dev/docs/runtime/storage) |
| Cache (KV) | `import { cache } from 'creek'` | `cache = true` | [/docs/runtime/cache](https://creek.dev/docs/runtime/cache) |
| AI (Workers AI) | `import { ai } from 'creek'` | `ai = true` | [/docs/runtime/ai](https://creek.dev/docs/runtime/ai) |
| Queue producer | `import { queue } from 'creek'` | `[triggers] queue = true` | [/docs/runtime/queue](https://creek.dev/docs/runtime/queue) |
| Realtime sync | `useLiveQuery()`, `db.mutate()` (from `creek/react`) | auto | [/docs/runtime/realtime](https://creek.dev/docs/runtime/realtime) |
| Hono helpers | `from 'creek/hono'` | auto | [/docs/runtime/hono](https://creek.dev/docs/runtime/hono) |

All runtime bindings are **request-scoped** (multi-tenant safe) and
deploy-time bound — no manual `wrangler.toml` plumbing.

---

## Operations — CLI, MCP, Dashboard

Imperative actions: deploy, manage, observe. Every capability below is
available through at least two surfaces so you can pick the one that
fits — human terminal, CI pipeline, AI agent, or web UI.

| Capability | CLI | MCP tool | Dashboard | Docs |
|---|---|---|---|---|
| Deploy current project (preview) | `creek deploy --sandbox` | — (use CLI; MCP `deploy` is file-map upload, not a project build) | Project → Deploy | [/docs/cli/deploy](https://creek.dev/docs/cli/deploy) |
| Deploy current project (production) | `creek deploy --prod` | `deploy_prod` (GitHub latest commit; does not wait) | Project → Deploy | [/docs/cli/deploy](https://creek.dev/docs/cli/deploy) |
| Deploy files to a 60-min sandbox | `creek deploy --sandbox` | `deploy` | — | [/docs/mcp](https://creek.dev/docs/mcp) |
| Deploy a demo page | — | `deploy_demo` | — | [/docs/mcp](https://creek.dev/docs/mcp) |
| Sandbox status / delete | `creek status <id>` | `deploy_status` / `deploy_delete` | — | [/docs/mcp](https://creek.dev/docs/mcp) |
| Verify a preview URL is live | `creek verify <url>` | — (GET the URL) | — | [/docs/cli/deploy](https://creek.dev/docs/cli/deploy) |
| Deploy directory | `creek deploy ./dist --sandbox` | — | — | [/docs/cli/deploy](https://creek.dev/docs/cli/deploy) |
| Deploy from GitHub URL | `creek deploy <repo-url> --sandbox` | — | Dashboard → New Project | [/docs/cli/deploy](https://creek.dev/docs/cli/deploy) |
| Deploy latest commit via connection | `creek deploy --from-github --prod [--project <slug>]` | `deploy_prod` | Project → Deploy latest | [/docs/cli/deploy#from-github](https://creek.dev/docs/cli/deploy) |
| GitHub auto-deploy (push → build) | — | — | Settings → GitHub Connection | [/docs/github](https://creek.dev/docs/github) |
| Pull request previews | — (automatic) | — | Commit status on PR | [/docs/github](https://creek.dev/docs/github) |
| Init project | `creek init` | — | — | [/docs/cli/init](https://creek.dev/docs/cli/init) |
| Login | `creek login [--token <KEY>]` | — | OAuth sign-in | [/docs/cli/login](https://creek.dev/docs/cli/login) |
| Who am I | `creek whoami` | — | User menu | [/docs/cli/whoami](https://creek.dev/docs/cli/whoami) |
| List projects | `creek projects` | `list_projects` | /projects | [/docs/cli/projects](https://creek.dev/docs/cli/projects) |
| List deployments | `creek deployments` | `list_deployments` | Project → Deployments | [/docs/cli/deployments](https://creek.dev/docs/cli/deployments) |
| Build log | `creek deployments logs <id>` | `get_build_log` | Project → Deployments | [/docs/cli/deployments](https://creek.dev/docs/cli/deployments) |
| Rollback | `creek rollback [<id>]` | `rollback` | Project → Deployments → ⋯ | [/docs/cli/rollback](https://creek.dev/docs/cli/rollback) |
| Promote preview → production | — | — | Project → Deployments → Promote | [/docs/cli/rollback](https://creek.dev/docs/cli/rollback) |
| Status | `creek status` | `get_status` | Per-project page | [/docs/cli/status](https://creek.dev/docs/cli/status) |
| Env vars | `creek env set/ls/rm` | `env_ls`, `env_set`, `env_rm` | Project → Env tab | [/docs/cli/env](https://creek.dev/docs/cli/env) |
| Team resources (DB / storage / cache / AI) | `creek db` / `storage` / `cache` | `list_resources`, `create_resource`, `attach_resource`, `detach_resource`, `delete_resource`, `rename_resource`, `query_database` | /resources | [/docs/cli/db](https://creek.dev/docs/cli/db) |
| Custom domains | `creek domains add/ls/activate/rm` | — | — | [/docs/cli/domains](https://creek.dev/docs/cli/domains) |
| Cron triggers | declared in `creek.toml`, shown in `creek status` | — | Settings → Triggers | [/docs/cron](https://creek.dev/docs/cron) |
| Queue triggers | `creek queue send` | — | Settings → Triggers | [/docs/queue](https://creek.dev/docs/queue) |
| Per-tenant analytics | — | — | Project → Analytics tab | [/docs/analytics](https://creek.dev/docs/analytics) |
| Dev server (local) | `creek dev` | — | — | [/docs/cli/dev](https://creek.dev/docs/cli/dev) |

Non-interactive (agent/CI) deploys must pass `--sandbox` or `--prod`. `--json` is auto-enabled without a TTY; it does not skip that gate. MCP project tools (header auth): `list_projects`, `get_status`, `env_ls`, `env_set`, `env_rm`, `deploy_prod`, `list_deployments`, `rollback`. `deploy_prod` requires a GitHub connection and does not wait for the build.

---

## `creek.toml` reference

The declarative project config. Source of truth for framework,
bindings, build command, triggers.

```toml
[project]
name = "my-app"                  # Required. Lowercase alphanumeric + hyphens.

[build]
command = "npm run build"        # Optional. Auto-detected if omitted.
output = "dist"                  # Build output directory

[resources]
database = true                  # D1 database   → env.DB + `import { db } from 'creek'`
storage  = true                  # R2 bucket     → env.BUCKET + `import { storage } from 'creek'`
cache    = true                  # KV namespace  → env.KV + `import { cache } from 'creek'`
ai       = true                  # Workers AI    → env.AI + `import { ai } from 'creek'`

[triggers]
cron  = ["0 */6 * * *"]          # Cron expression(s); multiple allowed
queue = true                     # Creates a per-project queue + consumer
```

Semantic binding names (`database` / `storage` / `cache`) are the
stable Creek names. The legacy Cloudflare names (`d1` / `r2` / `kv`)
are still accepted but deprecated.

Creek also reads `wrangler.toml` / `wrangler.jsonc` / `package.json` /
`index.html` as fallbacks when `creek.toml` is missing, in that order.

---

## Agent Skills

Creek ships [Agent Skills](https://agentskills.io) following the open
standard. Install with:

```bash
npx skills add solcreek/creek/skills
```

| Skill | What it teaches |
|---|---|
| [`creek`](skills/creek/SKILL.md) | Deploy, configure, troubleshoot Creek projects via the CLI + MCP — `--sandbox`/`--prod` target gate, `creek verify`, command reference, deployment modes, resources v2 (`creek db`), observability, CK-* diagnosis, creek.toml, GitHub auto-deploy |

Skills live at `skills/creek/` in this monorepo (source of truth).
MCP resources at `mcp.creek.dev` are copies under
`packages/mcp-server/references/` — run
`pnpm --filter @solcreek/mcp-server sync-refs` after editing a
reference, then deploy the MCP worker. `refs-sync.test.ts` fails CI
if the copies drift.

The legacy URL `npx skills add solcreek/skills` is deprecated — that
standalone repo is frozen and slated for archive. Use the monorepo
subpath above for all new installs.

---

## Self-hosting

All of the above runs on Cloudflare primitives. Creek itself is
open-source (Apache-2.0) and self-hostable — see
[/docs/self-hosting](https://creek.dev/docs/self-hosting) for the full
infrastructure setup.

---

## Keeping this file in sync

When you add a new capability to Creek, update this table in the same
PR. If it touches any of CLI / MCP / dashboard, check whether the
`creek` skill needs updating as well.

A `CAPABILITIES.md` check is part of the PR template — rows pointing
to nonexistent files will be flagged by CI.
