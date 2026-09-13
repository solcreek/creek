# Creek CLI — Command Reference

Complete command table. Pair with `references/workflows.md` for
common multi-command flows.

Non-interactive deploys need an explicit target: `--sandbox` (60-min
preview) or `--prod` (permanent, requires sign-in). `--json` is
auto-enabled when stdout is not a TTY; it does **not** skip the target gate.

| Task | Command |
|------|---------|
| Authenticate (CI / agent) | `creek login --token <KEY> --json` |
| Authenticate (human) | `creek login` |
| Check auth | `creek whoami --json` |
| Init project | `creek init --json` |
| Preview deploy plan | `creek deploy --dry-run --json` |
| Deploy sandbox | `creek deploy --sandbox --json` |
| Deploy production | `creek deploy --prod --json` |
| Deploy directory | `creek deploy ./dist --sandbox --json` |
| Deploy from GitHub URL | `creek deploy https://github.com/user/repo --sandbox --json` |
| Deploy monorepo subdir | `creek deploy https://github.com/user/repo --path packages/app --sandbox --json` |
| Deploy latest commit via GitHub connection | `creek deploy --from-github --prod --json` |
| Deploy latest (target specific project) | `creek deploy --from-github --project <SLUG> --prod --json` |
| Deploy template | `creek deploy --template vite-react --sandbox --json` |
| Skip build | `creek deploy --sandbox --skip-build --json` |
| Verify a preview URL is live | `creek verify <url> --json` |
| Verify with markup assert | `creek verify <url> --json --contains "unique text"` |
| Check status | `creek status --json` |
| Check sandbox | `creek status <SANDBOX_ID> --json` |
| Claim sandbox | `creek claim <SANDBOX_ID> --json` |
| List projects | `creek projects --json` |
| List deployments | `creek deployments --json` |
| List deployments (other) | `creek deployments --project <SLUG> --json` |
| Rollback | `creek rollback --json` |
| Preview rollback | `creek rollback --dry-run --json` |
| Rollback to specific | `creek rollback <DEPLOYMENT_ID> --json` |
| Set env var | `creek env set <KEY> <VALUE> --json` |
| Preview env set | `creek env set <KEY> <VALUE> --dry-run --json` |
| Preview env rm | `creek env rm <KEY> --dry-run --json` |
| List env vars | `creek env ls --json` |
| Show env values | `creek env ls --show --json` |
| Remove env var | `creek env rm <KEY> --json` |
| Add domain | `creek domains add <HOSTNAME> --json` |
| List domains | `creek domains ls --json` |
| Activate domain | `creek domains activate <HOSTNAME> --json` |
| Remove domain | `creek domains rm <HOSTNAME> --json` |
| Preview domain remove | `creek domains rm <HOSTNAME> --dry-run --json` |
| Send a message to the project queue | `creek queue send '<JSON-BODY>' --json` |
| Dev server (local) | `creek dev` |
| Dev server + trigger a cron firing | `creek dev --trigger-cron "*/5 * * * *"` |
| List team databases | `creek db ls --json` |
| Create a team database | `creek db create <NAME> --json` |
| Attach database to project | `creek db attach <NAME> --to <PROJECT> --as DATABASE --json` |
| Detach database from project | `creek db detach <NAME> --from <PROJECT> --json` |
| Rename a database | `creek db rename <NAME> --to <NEW-NAME> --json` |
| Delete a database | `creek db delete <NAME> --json` |
| Preview database delete | `creek db delete <NAME> --dry-run --json` |
| Tail runtime logs | `creek logs --json` |
| Tail runtime logs (live) | `creek logs --follow --json` |
| Filter runtime logs | `creek logs --outcome exception --since 1h --json` |
| Read a deployment's build log | `creek deployments logs <DEPLOYMENT_ID> --json` |
| Read raw build log ndjson | `creek deployments logs <DEPLOYMENT_ID> --raw` |
| Pre-deploy diagnostic | `creek doctor --json` |

## JSON Output Format

Every command returns structured JSON with breadcrumbs:

```json
{
  "ok": true,
  "url": "https://abcd1234.creeksandbox.com",
  "sandboxId": "abcd1234",
  "proof": { "ok": true, "status": 200, "title": "AX sim", "ttfbMs": 412 },
  "breadcrumbs": [
    { "command": "creek verify https://abcd1234.creeksandbox.com --json", "description": "Confirm the preview URL is live" },
    { "command": "creek status abcd1234", "description": "Check sandbox status" }
  ]
}
```

On error:

```json
{
  "ok": false,
  "error": "confirmation_required",
  "message": "Refusing to deploy from a non-interactive environment without an explicit target.",
  "breadcrumbs": [
    { "command": "creek deploy --dry-run", "description": "Preview the plan without executing" },
    { "command": "creek deploy --sandbox", "description": "Deploy to an ephemeral 60-minute sandbox" },
    { "command": "creek deploy --prod", "description": "Publish to production (requires sign-in)" }
  ]
}
```

Dry-run `nextStep` is a copy-pasteable command (`creek deploy --sandbox --json` or `--prod`). Follow it; do not strip the flags.
