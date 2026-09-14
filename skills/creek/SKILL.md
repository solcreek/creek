---
name: creek
description: Deploy, configure, and troubleshoot Creek projects via the CLI and MCP. Use when the user wants to deploy to Creek, debug a failed `creek deploy`, manage databases/storage/cache, or verify a preview URL.
---

# Creek

Creek deploys full-stack apps to Cloudflare Workers. Prefer the CLI over raw HTTP. Non-interactive (agent/CI) deploys **must** pass `--sandbox` or `--prod`; a bare `creek deploy --json` is refused.

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
- Do not call MCP tools named `deploy_project`, `list_projects`, `set_env_var` — they do not exist.
- Do not run `creek login` in a headless agent. Use `creek login --token <KEY> --json` or `CREEK_TOKEN`. Non-TTY `creek login` without `--token` returns `interactive_login_unsupported` (it used to hang on a browser callback).
- Mutating commands (`rollback`, `env set`/`rm`, `domains rm`, `db delete`, `storage delete`, `cache delete`) accept `--dry-run --json`. Follow `nextStep`; do not strip flags.

## MCP (https://mcp.creek.dev/mcp)

Sandbox, no auth: `deploy` (file map → preview URL), `deploy_demo`, `deploy_status`, `deploy_delete`.

Authenticated (API key **argument** today): `get_build_log`, `list_resources`, `create_resource`, `attach_resource`, `detach_resource`, `delete_resource`, `rename_resource`, `query_database`. Prefer the CLI (`creek db`, `creek deployments logs`) when you have a shell — the key stays out of the transcript.

After MCP `deploy`, GET the returned `url` (or `creek verify <url> --json`) before telling the user it worked.

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
