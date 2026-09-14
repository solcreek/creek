---
name: creek
description: Deploy, configure, and troubleshoot Creek projects via the CLI and MCP. Use when the user wants to deploy to Creek, debug a failed `creek deploy`, manage databases/storage/cache, or verify a preview URL.
---

# Creek

Creek deploys full-stack apps to Cloudflare Workers. Prefer the CLI over raw HTTP. Non-interactive (agent/CI) deploys **must** pass `--sandbox` or `--prod`; a bare `creek deploy --json` is refused.

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

`--yes` skips prompts (ToS). It is **not** implied by `--json`. `--sandbox` / `--prod` is what unblocks a non-TTY deploy.

## Do not

- Do not run `creek deploy` or `creek deploy --json` without `--sandbox` or `--prod` in a non-TTY. You will get `confirmation_required`.
- Do not treat dry-run `wouldDeploy: true` as a license to omit the flags in `nextStep`.
- Do not assert the entire HTML document after a sandbox deploy — Creek injects a banner script. Assert **your** markup with `--contains`.
- Do not POST to `sandbox-api.creek.dev` yourself. Some egress IPs get Cloudflare 1010. Use the CLI or MCP.
- Do not call MCP tools named `deploy_project` or `rollback` — they do not exist. Use `creek deploy --prod --json` / `creek rollback --json`. Project listing/status/env on MCP are `list_projects`, `get_status`, `env_ls`, `env_set`.
- Do not run `creek login` in a headless agent. Use `creek login --token <KEY> --json` or `CREEK_TOKEN`. Non-TTY `creek login` without `--token` returns `interactive_login_unsupported` (it used to hang on a browser callback).
- Mutating commands (`rollback`, `env set`/`rm`, `domains rm`, `db delete`, `storage delete`, `cache delete`) accept `--dry-run --json`. Follow `nextStep`; do not strip flags.

## MCP (https://mcp.creek.dev/mcp)

Sandbox, no auth: `deploy` (file map → preview URL + `proof`), `deploy_demo`, `deploy_status`, `deploy_delete`.

Authenticated tools (`list_projects`, `get_status`, `env_ls`, `env_set`, `get_build_log`, resource CRUD, `query_database`): send the key on the **HTTP request**, not as a tool argument:

```json
{ "mcpServers": { "creek": { "url": "https://mcp.creek.dev/mcp", "headers": { "Authorization": "Bearer <CREEK_TOKEN>" } } } }
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
