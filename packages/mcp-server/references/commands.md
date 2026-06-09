# Creek CLI — Command Reference

Complete command table. Pair with `references/workflows.md` for
common multi-command flows.

| Task | Command |
|------|---------|
| Authenticate | `creek login` |
| Authenticate (CI) | `creek login --token <KEY>` |
| Check auth | `creek whoami --json` |
| Init project | `creek init --json` |
| Deploy | `creek deploy --json` |
| Deploy directory | `creek deploy ./dist --json` |
| Deploy from GitHub URL | `creek deploy https://github.com/user/repo --json` |
| Deploy monorepo subdir | `creek deploy https://github.com/user/repo --path packages/app --json` |
| Deploy latest commit via GitHub connection | `creek deploy --from-github --json` |
| Deploy latest (target specific project) | `creek deploy --from-github --project <SLUG> --json` |
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
| Send a message to the project queue | `creek queue send '<JSON-BODY>' --json` |
| Dev server (local) | `creek dev` |
| Dev server + trigger a cron firing | `creek dev --trigger-cron "*/5 * * * *"` |
| List team databases | `creek db ls --json` |
| Create a team database | `creek db create <NAME> --json` |
| Attach database to project | `creek db attach <NAME> --to <PROJECT> --as DB --json` |
| Detach database from project | `creek db detach <NAME> --from <PROJECT> --json` |
| Rename a database | `creek db rename <NAME> --to <NEW-NAME> --json` |
| Delete a database | `creek db delete <NAME> --json` |
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
