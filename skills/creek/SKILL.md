---
name: creek
description: Deploy, configure, and troubleshoot Creek projects via the CLI and MCP. Use when the user wants to deploy to Creek, debug a failed `creek deploy`, manage databases/storage/cache, or verify a preview URL.
---

# Creek

Creek deploys full-stack apps to Cloudflare Workers. Prefer the CLI over raw HTTP. Non-interactive (agent/CI) deploys **must** name a target — pass `--sandbox` or `--prod` (`--yes` also gets past the gate, see below); a bare `creek deploy --json` is refused.

## Discover commands

```bash
creek --help --json                    # full command tree (args, dryRun, destructive)
creek deploy --help --json             # one command
creek env set --help --json            # nested subcommand
```

Do not scrape human `--help`. `destructive: true` means the command has `--dry-run`.

## Default loop

```bash
creek doctor --json
creek deploy --dry-run --json          # read wouldDeploy + nextStep; do not invent a command
# nextStep is copy-pasteable. Typical:
creek deploy --sandbox --json          # 60-min preview, no account
creek verify <url> --json --contains "unique markup from the app"
```

Signed-in production:

```bash
creek deploy --prod --json
```

`--yes` skips prompts (ToS). It is **not** implied by `--json`. `--sandbox`, `--prod` **or** `--yes` unblocks a non-TTY deploy, but `--yes` leaves the target implicit: signed in it deploys to **production** (with a deprecation warning on stderr), signed out to a sandbox. Prefer `--sandbox` / `--prod` so the destination is explicit.

`creek deploy --prod` waits up to 2 minutes for the deploy to finish. `--wait 15m` (or `900s`, `1h`, bare ms; clamped to 1s–60m) waits longer. `error: "timeout"` means the **CLI** stopped waiting, not that the deploy failed — it may still be running and go live. Check with `creek status --json` / `creek deployments --json` (and `creek deployments logs <ID> --json`) before redeploying.

## Do not

- Do not run `creek deploy` or `creek deploy --json` without `--sandbox`, `--prod` or `--yes` in a non-TTY. You will get `confirmation_required`.
- Do not treat a deploy `timeout` as a failure and redeploy blindly. Check `creek status --json` first; pass a longer `--wait` next time.
- Do not treat dry-run `wouldDeploy: true` as a license to omit the flags in `nextStep`.
- Do not use a branch (preview) deploy of a project to try unreviewed code: it runs with the project's production database and every env var not marked `--target production`. Use `--sandbox` (no secrets, no project resources). See `references/deployment-modes.md`.
- Do not assert the entire HTML document after a sandbox deploy — Creek injects a banner script. Assert **your** markup with `--contains`.
- Do not POST to `sandbox-api.creek.dev` yourself. Some egress IPs get Cloudflare 1010. Use the CLI or MCP.
- Production deploy on MCP is `deploy_prod` (GitHub connection, same as `creek deploy --from-github --prod`). It returns as soon as the build is dispatched, with a `deploymentId` — pass it to `wait_for_deployment` (or `get_deployment`), and on `deployment_failed` read `get_build_log`. If `deploymentId` is `null`, find the newest row for its `commitSha` with `list_deployments`. Rollback is `rollback`. Project listing/status/env: `list_projects`, `get_status`, `env_ls`, `env_set`, `env_rm`.
- Do not run `creek login` in a headless agent. Use `creek login --token <KEY> --json` or `CREEK_TOKEN`. Non-TTY `creek login` without `--token` returns `interactive_login_unsupported` (it used to hang on a browser callback).
- `CREEK_TOKEN` wins over the key `creek login` saved. `creek whoami --json` reports `tokenSource` and the key in use (`kind`, `team`, `effectiveScopes`, `expiresAt`); check `effectiveScopes` before a write. A key cannot mint or list keys (`creek keys ls`/`create` → `session_required`; use the dashboard). `creek logout --revoke --json` revokes the key in use and is safe to re-run. See `references/commands.md#api-keys`.
- Mutating commands (`rollback`, `env set`/`rm`, `domains rm`, `db delete`, `storage delete`, `cache delete`) accept `--dry-run --json`. Follow `nextStep`; do not strip flags.
- Do not retry an `unknown_flag` error by dropping `--dry-run`. That flag was not a preview — older CLIs silently ignored it and executed the mutation. Use `--help --json` (`destructive: true` means `--dry-run` exists).
- `creek rollback` without an id skips synthetic `triggerType=rollback` rows. Prefer the id from `creek rollback --dry-run --json` / `list_deployments`.

## MCP (https://mcp.creek.dev)

Sandbox, no auth: `deploy` (file map → preview URL + `proof`), `deploy_demo`, `deploy_status`, `deploy_delete`.

Every MCP tool answers JSON: `{ ok: true, … }` or `{ ok: false, error, message, … }`. Branch on `error`. `api_unreachable` carries `retryable` — retry only when it is `true`. A sandbox failure after creation (`timeout`, `deploy_failed`, `verify_failed`) carries `sandboxId`: call `deploy_status` with it, do not deploy again.

Authenticated tools (`whoami` — the key in use, read-only; `list_projects`, `get_status`, `env_ls`, `env_set`, `env_rm`, `deploy_prod`, `list_deployments`, `get_deployment`, `wait_for_deployment`, `rollback`, `get_build_log`, resource CRUD, `query_database`): send the key on the **HTTP request**, not as a tool argument:

```json
{ "mcpServers": { "creek": { "url": "https://mcp.creek.dev", "headers": { "Authorization": "Bearer <CREEK_TOKEN>" } } } }
```

Do not pass `apiKey` to tools. Prefer the CLI (`creek db`, `creek deployments logs`) when you have a shell.

MCP `deploy` JSON includes `proof` (GET of the preview URL). If `proof.ok` is false, treat the deploy as unverified even if `url` is present.

`creek deploy --prod --json` also attaches `proof`. 2xx and 3xx count as live (a 302 to a login page is still a live site).

## References

Read only what the task needs:

- `references/commands.md` — full CLI table
- `references/workflows.md` — first deploy / rollback / domain
- `references/deployment-modes.md` — sandbox vs production vs GitHub
- `references/diagnosis.md` — failed deploy runbook + CK-* codes
- `references/observability.md` — runtime logs vs build logs
- `references/resources.md` — `creek db` / attach / portable schema split
- `references/creek-toml.md` — config schema
- `references/github-setup.md` — GitHub app + `--from-github`
