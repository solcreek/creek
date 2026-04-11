---
name: creek
description: |
  Deploy and manage applications on Creek via the Creek CLI. Covers init, deploy,
  status, projects, deployments, rollback, env vars, custom domains, and dev server.
  Use when the user mentions creek, creek deploy, creek init, or wants to deploy,
  configure, or troubleshoot a Creek project.
license: Apache-2.0
compatibility: Requires Creek CLI (npm install -g creek)
metadata:
  author: solcreek
  version: "2.1"
  required-binaries: creek
  required-env: CREEK_TOKEN
---

# Creek CLI — Agent Skill

Creek deploys web apps to Cloudflare Workers with a single command. Auto-detects framework, determines render mode (SPA/SSR/Worker), provisions infrastructure.

## Agent Rules

1. **Always use `--json`** for structured output. Auto-enabled in non-TTY / CI.
2. **Follow `breadcrumbs`** in JSON responses — they suggest the next command.
3. **Use `--yes`** to skip confirmation prompts (auto-enabled in non-TTY).
4. **Check `ok` field** — `true` = success, `false` = error with `error` and `message` fields.

## Command Reference

| Task | Command |
|------|---------|
| Authenticate | `creek login` |
| Authenticate (CI) | `creek login --token <KEY>` |
| Check auth | `creek whoami --json` |
| Init project | `creek init --json` |
| Deploy | `creek deploy --json` |
| Deploy directory | `creek deploy ./dist --json` |
| Deploy from GitHub | `creek deploy https://github.com/user/repo --json` |
| Deploy monorepo subdir | `creek deploy https://github.com/user/repo --path packages/app --json` |
| Deploy demo | `creek deploy --demo --json` |
| Deploy template | `creek deploy --template vite-react` |
| Skip build | `creek deploy --skip-build --json` |
| Check status | `creek status --json` |
| Check sandbox | `creek status <SANDBOX_ID> --json` |
| Claim sandbox | `creek claim <SANDBOX_ID> --json` |
| List projects | `creek projects --json` |
| List deployments | `creek deployments --json` |
| List deployments (other) | `creek deployments --project <SLUG> --json` |
| Rollback | `creek rollback --json` |
| Rollback to specific | `creek rollback <DEPLOYMENT_ID> --json` |
| Set env var | `creek env set <KEY> <VALUE> --json` |
| List env vars | `creek env ls --json` |
| Show env values | `creek env ls --show --json` |
| Remove env var | `creek env rm <KEY> --json` |
| Add domain | `creek domains add <HOSTNAME> --json` |
| List domains | `creek domains ls --json` |
| Activate domain | `creek domains activate <HOSTNAME> --json` |
| Remove domain | `creek domains rm <HOSTNAME> --json` |
| Dev server | `creek dev` |

## Deployment Modes

### Authenticated (permanent)
Requires `creek login`. Deploys persist under the user's account.
```bash
creek deploy --json
```

### Sandbox (60-min preview)
No auth required. Temporary preview with claimable URL.
```bash
creek deploy --json          # auto-sandbox when not logged in
creek claim <SANDBOX_ID>     # convert to permanent project
```

### CI/CD
```bash
CREEK_TOKEN=ck_... creek deploy --yes --json
```

## JSON Output Format

Every command returns structured JSON with breadcrumbs:

```json
{
  "ok": true,
  "url": "https://my-app-team.bycreek.com",
  "project": "my-app",
  "breadcrumbs": [
    { "command": "creek status", "description": "Check deployment status" },
    { "command": "creek deployments --project my-app", "description": "View deployment history" }
  ]
}
```

On error:
```json
{
  "ok": false,
  "error": "not_authenticated",
  "message": "Not authenticated. Run `creek login` first.",
  "breadcrumbs": [
    { "command": "creek login", "description": "Authenticate interactively" }
  ]
}
```

## Workflow: First Deploy

```bash
creek login --json                # 1. Authenticate
creek init --json                 # 2. Create creek.toml (optional)
creek deploy --json               # 3. Deploy
```

## Workflow: Update & Rollback

```bash
creek deploy --json               # Deploy new version
creek deployments --json          # View history
creek rollback --json             # Rollback to previous
creek rollback <ID> --json        # Rollback to specific deployment
```

## Workflow: Custom Domain

```bash
creek domains add app.example.com --json     # Add domain
# User sets DNS: CNAME app.example.com → cname.creek.dev
creek domains activate app.example.com --json # Activate after DNS
creek domains ls --json                       # Verify status
```

## creek.toml Reference

```toml
[project]
name = "my-app"              # Required. Lowercase alphanumeric + hyphens.
framework = "nextjs"         # Optional. Auto-detected from package.json.

[build]
command = "npm run build"    # Build command (default: npm run build)
output = "dist"              # Build output directory
worker = "worker/index.ts"   # Optional: custom Worker entry point

[resources]
d1 = true                   # Cloudflare D1 database   → env.DB
kv = true                   # Cloudflare KV namespace   → env.KV
r2 = true                   # Cloudflare R2 storage     → env.BUCKET
ai = true                   # Cloudflare Workers AI     → env.AI
```

## Supported Frameworks

**SPA**: vite-react, vite-vue, vite-svelte, vite-solid, static HTML
**SSR**: nextjs, react-router, sveltekit, nuxt, solidstart, tanstack-start

## Config Detection Order

1. `creek.toml` — explicit Creek config
2. `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` — existing CF config
3. `package.json` — framework auto-detection
4. `index.html` — static site

## Troubleshooting

| Error | Fix |
|-------|-----|
| "Not authenticated" | `creek login` or set `CREEK_TOKEN` |
| "Invalid API key" | `creek login` to re-authenticate |
| "No creek.toml found" | `creek init` or cd to project root |
| "No project found" | Deploy from a dir with package.json or index.html |
| "No supported project found in repo" | Use `--path` for monorepos |
| Sandbox expired | Redeploy — sandboxes last 60 minutes |
| Domain stuck "pending" | Set CNAME to `cname.creek.dev`, then `creek domains activate` |
| Build fails | Check `[build] command` in creek.toml |
