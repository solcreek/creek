# Creek CLI — Deployment Modes

Four ways to invoke `creek deploy`. Pick based on where the build runs
and whether the result persists.

## Authenticated (permanent)

Requires `creek login`. Deploys persist under the user's account.
Builds locally, uploads the bundle, deploys to Workers for Platforms.

```bash
creek deploy --json
```

## Sandbox (60-min preview)

No auth required. Temporary preview with claimable URL.

```bash
creek deploy --json          # auto-sandbox when not logged in
creek claim <SANDBOX_ID>     # convert to permanent project
```

Sandbox env vars are restricted — user-set secrets are not injected.
Code that depends on an LLM API key or similar should gate on the
env var being present and fall back gracefully, then deploy to
production for full env access.

## CI/CD

```bash
CREEK_TOKEN=ck_... creek deploy --yes --json
```

`--yes` is auto-enabled in non-TTY environments (no confirmation
prompts). `--json` output is also auto-enabled in non-TTY.

## Remote build via GitHub connection

When the project has a GitHub connection (set up via the dashboard's
`/new` import flow or `/projects/:id/settings`), Creek can deploy the
latest commit on the project's production branch **without** running
the build locally. The control-plane fetches the commit, invokes the
same remote-builder container used by `git push` webhooks, and runs
the full deploy pipeline server-side.

Use this when:
- You want to redeploy from a machine that doesn't have the source
  checked out (fresh CI runner, different laptop, an agent with a
  narrow workspace).
- You want to trigger a deploy without pushing a commit.
- You want CI capability parity with the dashboard "Deploy latest"
  button.

```bash
# Infer the project from creek.toml in cwd
creek deploy --from-github --json

# Or target an explicit project by slug (or UUID)
creek deploy --from-github --project my-app --json
```

The command polls the deployments list until the new row settles on
`active`, `failed`, or `cancelled`, and prints each status transition.
Fails fast if the project has no github_connection or the connection's
production branch has no accessible commit.
