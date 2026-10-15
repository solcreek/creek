# Creek CLI — Command Reference

Complete command table. Pair with `references/workflows.md` for
common multi-command flows.

Discover the live tree with `creek --help --json` (or `creek <cmd> --help --json`). Do not scrape human usage text.

Each command in the schema carries:
- `destructive`: running it may delete or overwrite existing data or change what is live. Set per command and reviewed.
- `dryRun`: it accepts `--dry-run`.
- `aliases`: other names for the same command, e.g. `env rm` → `["unset"]`.
- `args[].enum`: when present, the only values an arg accepts, e.g. `env set --target`.

Destructive: `deploy`, `rollback`, `init`, `env set`/`rm`, `domains rm`, `projects delete`, `db|storage|cache detach`/`delete`, `db shell`/`migrate`/`seed`, `restart`, `stop`.

Non-interactive deploys need an explicit target: `--sandbox` (60-min
preview) or `--prod` (permanent, requires sign-in). `--json` is
auto-enabled when stdout is not a TTY; it does **not** skip the target gate.

Project commands (`env`, `status`, `deployments`, `logs`, `metrics`,
`domains`, `queue`, `rollback`, `db shell`/`db migrate`, `doctor --last`)
act on the project the directory names: `--project <SLUG>` (every one
accepts it, and it wins), else `creek.toml` `[project].name`, else the
wrangler config's `name`, else the framework `package.json` `name`. They
never fall back to the directory name: a static site (`index.html`) or a
wrangler config / package.json without `name` exits
`{"ok":false,"error":"no_project","foundConfig":"<file>"}`, as does a
directory with no config. Pass `--project` (find the slug with
`creek projects --json`). The JSON output carries `projectSource`
(`flag`, `creek.toml`, `wrangler` or `package.json`): check it says what
you meant to target.

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
| Check status (other project) | `creek status --project <SLUG> --json` |
| Check sandbox | `creek status <SANDBOX_ID> --json` |
| Claim sandbox | `creek claim <SANDBOX_ID> --json` |
| List projects | `creek projects --json` |
| List deployments | `creek deployments --json` |
| List deployments (other) | `creek deployments --project <SLUG> --json` |
| Rollback | `creek rollback --json` |
| Preview rollback | `creek rollback --dry-run --json` |
| Rollback to specific | `creek rollback <DEPLOYMENT_ID> --json` |
| Set env var | `creek env set <KEY> <VALUE> --json` |
| Set env var (other project) | `creek env set <KEY> <VALUE> --project <SLUG> --json` |
| Production-only secret | `creek env set <KEY> <VALUE> --target production --json` |
| Preview-only value | `creek env set <KEY> <VALUE> --target preview --json` |
| Remove one target's value | `creek env rm <KEY> --target <production\|preview\|all> --json` |
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

When the Creek API refused the call, the error also carries `status` (HTTP), `apiError` (the API's own code) and, when it has any, `details`. `error` stays the command's code (`set_failed`, `attach_failed`, …); an error no command handles uses the API's code as `error`:

```json
{
  "ok": false,
  "error": "set_failed",
  "message": "This API key lacks the scope: env:write",
  "status": 403,
  "apiError": "insufficient_scope",
  "details": { "required": ["env:write"], "requiredMode": "all", "granted": ["deploy:preview", "project:read"] }
}
```

Act on `apiError`:

| `apiError` | Meaning | What to do |
|---|---|---|
| `insufficient_scope` | The API key lacks a scope (`details.required`; it has `details.granted`) | Use a key that holds the scope; don't retry with the same key |
| `insufficient_role` | The key holds the scope but its owner's team role no longer allows it | Ask a team owner/admin |
| `binding_conflict` | The deploy's binding names collide (`details.conflicts`) | See [diagnosis](diagnosis.md) |
| `conflict` | The name is taken; `details.existing` is what holds it (a resource on `create`, a binding on `attach`) | Pick another name, or use `details.existing.id` / detach what holds it |
| `unauthorized` (`status` 401) | The key was not accepted | `creek login` with a valid key |

`error: "api_unreachable"` (no `status`) means communication with the server failed — it was never reached, or the connection broke mid-request — not that the key was refused. Re-run the command only when `retryable` is `true`: the failure is transient (refused, reset, timeout, network down) and nothing this run changes can have been applied — it only read, or its writes provably never left. `mayHaveApplied: true` means a write of this run (this request or an earlier step, e.g. `creek deploy`'s create-deployment before its upload) may have been applied: check (`creek status`, `creek deployments`) before running the command again. Otherwise stop and tell the user: `reason` (absent when the failure gave none) names what to fix — `ENOTFOUND` (no network, or a wrong host in `CREEK_API_URL`), a certificate error (e.g. a proxy's self-signed certificate), `bad port`, `unknown scheme`.

MCP tools return the same `error` (the API's code), `message`, `status` and `details`.

`creek db|storage|cache create/attach/detach/delete` are safe to re-run. When the result is already in place they succeed (`ok: true`, exit 0) and say so: `alreadyExists: true` on `create` (with the existing `resource`) and `attach` (with the existing `binding`), `alreadyAbsent: true` on `detach` and `delete`. A fresh result carries `alreadyExists` / `alreadyAbsent: false`. A real clash still fails — see [resources](resources.md#re-running-commands).

Dry-run `nextStep` is a copy-pasteable command (`creek deploy --sandbox --json` or `--prod`). Follow it; do not strip the flags.
