---
name: creek
description: |
  Deploy and manage full-stack apps to the edge with Creek — one
  command from local code to a live URL. Ship, diagnose failed deploys,
  read runtime + build logs, manage team-owned databases (creek db),
  handle custom domains, cron, queues, GitHub push deploys, and local
  dev. Skill covers Creek's conventions (semantic resource keys,
  shared schema + split boot pattern, unified sandbox/production code
  path) plus CK-error code fix hints.
when_to_use: |
  Use when the user mentions creek, creek.dev, creek.toml, creek deploy,
  creek db, creek logs, creek doctor, `npx creek`, or "deploy to the
  edge". Also use when a user says "my deploy failed" / "deploy to creek
  didn't work" / "add a database to my creek project" / "why isn't my
  push deploying" / "can I share a database across projects" / "is my
  cron running". Pre-emptively load when editing creek.toml or code
  that imports from @solcreek/*.
license: Apache-2.0
compatibility: Requires Creek CLI (npm install -g creek)
paths:
  - "**/creek.toml"
  - "**/examples/vite-react-drizzle/**"
  - "**/server/{local,worker,routes,schema}.ts"
metadata:
  author: solcreek
  required-binaries: creek
  required-env: CREEK_TOKEN
---

# Creek CLI — Agent Skill

Creek deploys full-stack web apps to the edge with a single command.
Auto-detects framework, determines render mode (SPA/SSR/Worker),
provisions infrastructure.

## Mental Model

Creek manages the deploy target, bindings, and runtime for you. You
work with semantic concepts — `database`, `cache`, `storage`, `ai` —
not infrastructure primitives. The CLI and `@solcreek/runtime` cover
the concerns you'd normally write glue code for.

Rule of thumb: if you're about to write platform-level glue (editing
generated config, manually provisioning infra, swapping drivers across
local/production), check whether `creek` or `@solcreek/runtime` already
handles it. It almost always does.

## Conventions that matter on first pass

Creek deviates from common deployment heuristics in a few specific
ways. Getting these right up front avoids dead-end rewrites.

- **Semantic resource keys.** In `creek.toml [resources]`, use
  `database`, `cache`, `storage`, `ai`. These map to infrastructure
  automatically. Other names are silently dropped — `creek doctor`
  flags this with `CK-RESOURCES-KEYS`.

- **Provision via `creek db create <name>`, not platform-specific
  tooling.** Creates a team-owned resource with a stable UUID that
  can be renamed, shared across projects, and detached without
  dropping data. Provisioning outside Creek creates orphaned
  infrastructure the platform can't track.

- **One code path for sandbox and production.** Env var behavior is
  identical. Sandbox just runs without user-set secrets. Gate on
  `env.MY_KEY` being present; don't fork code paths.

- **Shared schema + split boot files for portable DB code.** The
  recommended shape: one `schema.ts` + one `routes.ts` (driver-agnostic)
  + thin boot files (`server/local.ts` for local dev, `server/worker.ts`
  for production) that differ only in driver setup. Never duplicate
  the schema across local and production files — `creek doctor` flags
  this with `CK-DB-DUAL-DRIVER-SPLIT`. See `references/resources.md`
  and `examples/vite-react-drizzle`.

- **`creek.toml` is the source of truth for config.** Creek generates
  its deploy-target config at build time. Hand-edits to generated
  files get reverted on next deploy. If an existing project has a
  legacy config file from another tool, `creek doctor` flags it with
  `CK-CONFIG-OVERLAP` and guides the reconciliation.

## Quick Triage

Map user phrasing to the right workflow before doing anything else.

| User says / implies | First command |
|---------------------|--------------|
| "deploy this" (no context) | `creek deploy --dry-run --json` first, then `creek deploy --json` |
| "deploy failed" / "something broke" | See `references/diagnosis.md` |
| "can't see logs" | Is it missing because edge-cached? See `references/observability.md` |
| "add a database" / "need a DB" (no account) | Sandbox auto-provisions: add `[resources] database = true` to creek.toml. See "Sandbox with DB" below. |
| "add a database" / "need a DB" (signed in) | `creek db create <name>` + `creek db attach` (see `references/resources.md`) |
| "how do I run this locally" | `creek dev` |
| "rollback the last deploy" | `creek rollback --json` |
| "add a domain" | `creek domains add <host>` + DNS CNAME → `creek domains activate` |
| "why isn't my push deploying" | See `references/github-setup.md` |
| "what env vars does it see" | `creek env ls --json` (add `--show` for values) |
| "is my cron running" | `creek status --json` shows cron schedules |

If the phrasing doesn't match any row, default to `creek doctor --json`
— it surfaces the most likely misconfiguration.

## Sandbox with DB (no account, 60 min preview)

Sandbox mode auto-provisions a database when `creek.toml` declares
`[resources] database = true` — no `creek login`, no `creek db create`
required. The binding name is `DB`. This makes it safe to build a
DB-backed CRUD demo (e.g. TODO list) and ship a live URL in one step.

```toml
# creek.toml
[project]
name = "todo-app"

[build]
worker = "worker.ts"      # required for API routes
output = "public"         # static assets dir (at minimum: index.html)

[resources]
database = true           # NOT d1 = true — doctor flags that as error
```

```ts
// worker.ts
import { define } from "d1-schema";

export interface Env { DB: D1Database }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    await define(env.DB, {
      todos: { id: "text primary key", text: "text not null", completed: "integer default 0" },
    });
    // ...env.DB.prepare("SELECT * FROM todos").all()
  },
};
```

Constraints to know before starting:

- **`public/index.html` is required.** Sandbox rejects worker-only
  bundles with `No assets in bundle`. Serve your UI as static + use
  the worker for `/api/*`.
- **`creek deploy --dry-run --json` first.** It runs the full
  doctor check and surfaces `[resources]` typos (e.g. the `d1/kv/r2`
  vs `database/cache/storage` split) before you burn a deploy.
- **`creek logs` and `creek doctor --last` need auth**, so runtime
  errors in sandbox are hard to diagnose. Return JSON errors with a
  meaningful `message` from your handlers so failures surface via the
  HTTP response instead.

## Agent Rules

1. **Always use `--json`** for structured output. Auto-enabled in non-TTY / CI.
2. **Follow `breadcrumbs`** in JSON responses — they suggest the next command.
3. **Use `--yes`** to skip confirmation prompts (auto-enabled in non-TTY).
4. **Check `ok` field** — `true` = success, `false` = error with `error` and `message` fields.

## Cheat Sheet

Top commands. Full table in `references/commands.md`.

| Task | Command |
|------|---------|
| Authenticate | `creek login` |
| Deploy | `creek deploy --json` |
| Dry-run plan (safe, no side effects) | `creek deploy --dry-run --json` |
| Check status | `creek status --json` |
| List deployments | `creek deployments --json` |
| Read a deployment's build log | `creek deployments logs <ID> --json` |
| Rollback | `creek rollback --json` |
| Runtime logs | `creek logs --follow --json` |
| Pre-deploy diagnostic | `creek doctor --json` |
| Create team database | `creek db create <NAME> --json` |

## Additional Resources

Load on demand. These files live in `references/` and are meant to be
read via `bash cat` when the task needs the detail.

- `references/commands.md` — complete command table + JSON output spec
- `references/deployment-modes.md` — authenticated / sandbox / CI / remote-GitHub
- `references/workflows.md` — first-deploy / update-rollback / custom-domain, framework matrix, config detection order
- `references/creek-toml.md` — full `creek.toml` reference, cron + queue details
- `references/diagnosis.md` — failure diagnosis workflow + CK-code fix table + error-string troubleshooting
- `references/observability.md` — `creek logs` + `creek deployments logs` + MCP `get_build_log` + edge-cache caveats
- `references/resources.md` — `creek db` + team-owned resource model + portable pattern
- `references/github-setup.md` — GitHub App install + repo connection
