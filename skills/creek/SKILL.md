---
name: creek
description: |
  Deploy and manage apps on Creek — the Cloudflare Workers deployment
  platform. Ship, diagnose failed deploys, read runtime + build logs,
  manage team-owned databases (creek db), handle custom domains, cron,
  queues, GitHub push deploys, and local dev. Skill also corrects the
  CF-native reflexes that look right but break on Creek (do NOT swap
  better-sqlite3 → D1 manually, do NOT hand-edit wrangler.toml, do NOT
  maintain separate sandbox/prod code paths).
when_to_use: |
  Use when the user mentions creek, creek.dev, creek.toml, creek deploy,
  creek db, creek logs, creek doctor, `npx creek`, deploying to
  Cloudflare, or asks about Workers for Platforms tenancy. Also use
  when a user says "my deploy failed" / "deploy to creek didn't work"
  / "add a database to my creek project" / "why isn't my push
  deploying" / "can I share a database across projects" / "is my
  cron running". Pre-emptively load when editing creek.toml,
  wrangler.jsonc, or code that imports from @solcreek/*.
license: Apache-2.0
compatibility: Requires Creek CLI (npm install -g creek)
paths:
  - "**/creek.toml"
  - "**/wrangler.{json,jsonc,toml}"
  - "**/examples/vite-react-drizzle/**"
  - "**/server/{local,worker,routes,schema}.ts"
metadata:
  author: solcreek
  required-binaries: creek
  required-env: CREEK_TOKEN
---

# Creek CLI — Agent Skill

Creek deploys web apps to Cloudflare Workers with a single command.
Auto-detects framework, determines render mode (SPA/SSR/Worker),
provisions infrastructure.

## Mental Model

Creek runs on Cloudflare Workers, but **it is not raw Cloudflare**. The
resource model, deploy flow, and runtime are abstracted. An agent
reaching for CF-native workarounds (wrangler.toml edits, manual D1
creation, driver rewrites) is almost always wrong on Creek.

The rule of thumb: if you're about to write CF-specific glue code, check
whether the `creek` CLI or `@solcreek/runtime` already covers the concern.
If yes — use the Creek path.

## What you DON'T need to do on Creek

Because Creek visibly runs on CF, it's tempting to apply CF reasoning.
Don't. These five shortcuts are all counterproductive:

- **Do NOT swap `better-sqlite3` → D1 manually before deploy.** The
  recommended pattern keeps one shared schema + one shared query/routes
  file, driver-agnostic. Only the thin boot files differ
  (`server/local.ts` uses `better-sqlite3`, `server/worker.ts` uses
  D1). See `references/resources.md` and `examples/vite-react-drizzle`.

- **Do NOT maintain separate sandbox/production code paths.** Env var
  behavior is identical. Sandbox just runs without user-set secrets.
  Gate on `env.MY_KEY` being present; deploy to production via
  `creek deploy` when the full env is needed.

- **Do NOT hand-edit `wrangler.toml`.** Creek reads `creek.toml` and
  generates wrangler config at build time. Bindings are declared in the
  dashboard or via `creek db attach` — not in wrangler.toml.

- **Do NOT create a D1 via `wrangler d1 create`.** Use `creek db create
  <name>` — it creates a team-owned resource that can be renamed, shared
  across projects, and detached without dropping data.

- **Do NOT duplicate schema or queries across `db.local.ts` +
  `db.prod.ts` files.** Use the shared-routes + split-boot pattern
  from `references/resources.md`. `creek doctor` flags the split with
  `CK-DB-DUAL-DRIVER-SPLIT`.

## Quick Triage

Map user phrasing to the right workflow before doing anything else.

| User says / implies | First command |
|---------------------|--------------|
| "deploy this" (no context) | `creek deploy --dry-run --json` first, then `creek deploy --json` |
| "deploy failed" / "something broke" | See `references/diagnosis.md` |
| "can't see logs" | Is it missing because edge-cached? See `references/observability.md` |
| "add a database" / "need a DB" | `creek db create <name>` + `creek db attach` (see `references/resources.md`) |
| "how do I run this locally" | `creek dev` |
| "rollback the last deploy" | `creek rollback --json` |
| "add a domain" | `creek domains add <host>` + DNS CNAME → `creek domains activate` |
| "why isn't my push deploying" | See `references/github-setup.md` |
| "what env vars does it see" | `creek env ls --json` (add `--show` for values) |
| "is my cron running" | `creek status --json` shows cron schedules |

If the phrasing doesn't match any row, default to `creek doctor --json`
— it surfaces the most likely misconfiguration.

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
