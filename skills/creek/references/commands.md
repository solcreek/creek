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
| Show the API key in use | `creek keys self --json` |
| Log out (key stays valid) | `creek logout --json` |
| Log out and revoke the key | `creek logout --revoke --json` |
| Revoke the key in use | `creek keys revoke --self --json` |
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
| Check a deployment or sandbox by id | `creek status <ID> --json` (`type`: `deployment` or `sandbox`; deployment ids are looked up in `--project` or the cwd's project) |
| Show one deployment | `creek deployments get <DEPLOYMENT_ID> --json` (status, final, failedStep, errorCode/errorHint, url, commitSha, branch) |
| Wait for a deployment to finish | `creek deployments wait <DEPLOYMENT_ID> --timeout 5m --json` (exit 0 active; 1 `deployment_failed` / `deployment_cancelled`; 1 `timeout` + `retryable: true` — run it again) |
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
| List env keys and targets (values are write-only) | `creek env ls --json` |
| Remove env var | `creek env rm <KEY> --json` |
| Add domain | `creek domains add <HOSTNAME> --json` |
| List domains | `creek domains ls --json` |
| Activate domain | `creek domains activate <HOSTNAME> --json` |
| Remove domain | `creek domains rm <HOSTNAME> --json` |
| Preview domain remove | `creek domains rm <HOSTNAME> --dry-run --json` |
| Send a JSON message to the project queue | `creek queue send '<JSON-BODY>' --parseJson --json` (`-j` for short; the CLI rejects `--parse-json` as `unknown_flag`) |
| Send a plain-string message | `creek queue send '<TEXT>' --json` (without `--parseJson` the body is sent as a string, even if it looks like JSON) |
| Dev server (local) | `creek dev` |
| Trigger a cron firing in dev | type `cron` + Enter in the running `creek dev` terminal (only when `[triggers] cron` is set; there is no `--trigger-cron` flag) |
| Send a queue message in dev | type `queue <JSON-OR-TEXT>` + Enter in the running `creek dev` terminal (only when `[triggers] queue = true`) |
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
| Wait longer for a production deploy | `creek deploy --prod --wait 15m --json` (default 2m; a `timeout` result means the CLI stopped waiting — the deploy may still be running: follow its `deploymentId` with `creek deployments wait <ID> --json`) |

## API keys

The CLI authenticates every request with an API key. `CREEK_TOKEN`, when
set (even empty), wins over the key `creek login --token` saved in
`~/.creek/config.json`; `creek login` then returns a `warning` saying so.

`creek login` binds the saved key to the API it was verified against
(`tokenApiUrl` in the config). Every command sends a bound key only to that
API: when the CLI would talk to another one (`CREEK_API_URL`, or the
config's `apiUrl`), any command that needs the key exits 1 with
`error: "api_mismatch"`, `savedKeyApiUrl` and `apiUrl`, before any request.
A key saved by an older CLI is unbound (its API is unknown): it is sent to
the API in use, as before, and `whoami` reports `keyBinding: "unbound"` —
run `creek login --token <KEY>` again against the intended API to bind it.
`CREEK_TOKEN` is never bound: it is sent to the API in use.

`creek whoami --json` says which key is in use:

```json
{
  "ok": true,
  "email": "owner@example.com",
  "tokenSource": "env:CREEK_TOKEN",
  "key": {
    "id": "…", "name": "ci", "kind": "scoped",
    "team": { "id": "…", "slug": "acme" },
    "scopes": ["env:read", "env:write", "project:read"],
    "effectiveScopes": ["env:read", "project:read"],
    "expiresAt": "2027-01-01T00:00:00.000Z", "lastUsedAt": "…"
  },
  "warning": "CREEK_TOKEN is set: it overrides the key saved by `creek login` …"
}
```

- `tokenSource`: `env:CREEK_TOKEN` or `config`.
- `kind: "legacy"`: no scopes, the owner's full access in every team (`scopes`
  and `effectiveScopes` are `null`, `key.warning` says it will be retired).
  `kind: "scoped"`: pinned to `team`; `effectiveScopes` is what the key can
  use now (its scopes the owner's current role still allows). Check it before
  a write instead of waiting for `insufficient_scope`.
- `key: null` with `keyLookup.error: "server_unsupported"` means the API
  predates key details; whoami still exits 0.
- `error: "key_unusable"` (exit 1) with `key.access: "none"`: the API knows
  the key but refuses to act with it (its owner left the pinned team, or its
  scopes are unreadable); `message` says which. Revoke it and use another key.

A key can read and revoke only itself. Minting, listing and revoking other
keys need a signed-in dashboard session, which the CLI never holds:
`creek keys ls` and `creek keys create` exit 1 with
`error: "session_required"` and `dashboardUrl`, without calling the API.

`creek logout` forgets the saved key, but the key stays valid
(`keyStillValid: true`). Once forgotten it can only be revoked in the
dashboard (`dashboardUrl`), so prefer `--revoke`.

`creek logout --revoke` revokes one key: the active one, the key `whoami`
uses (`source`, `keyPrefix`, `revoked`, `keyId` or `reason`).

- `CREEK_TOKEN` set (even empty) and a different saved key:
  `error: "ambiguous_credentials"`, nothing sent. Pick one:
  `unset CREEK_TOKEN && creek logout --revoke --json` (the saved key), or
  `creek keys revoke --self --json` (the `CREEK_TOKEN` key).
- Only a 2xx (`revoked: true`) or a 401 (`revoked: false`,
  `reason: "already_invalid"`) is a known outcome; both clear the saved key.
  Anything else exits 1 with `mayHaveApplied: true` and keeps the key:
  re-run `creek logout --revoke --json` (a revoked key then answers
  `already_invalid`).
- The saved key is removed only if the config still holds that exact key; a
  `creek login` that ran meanwhile is kept (`configCleared: false`,
  `configReason: "changed_during_logout"`).
- With `CREEK_TOKEN` set, `unset CREEK_TOKEN` afterwards.

## JSON Output Format

Every command returns one JSON document with `ok: true | false`; a failure (`ok: false`, non-zero exit) also carries `error` (a code to branch on) and `message` (for the user). Most add `breadcrumbs`. The exception is `creek logs --json`, which is NDJSON ending in a `{"ok":true,"type":"summary","count":N}` line — see [observability](observability.md#runtime-logs--creek-logs).

```json
{
  "ok": true,
  "url": "https://abcd1234.creeksandbox.com",
  "sandboxId": "abcd1234",
  "proof": { "ok": true, "status": 200, "title": "AX sim", "ttfbMs": 412 },
  "breadcrumbs": [
    { "command": "creek verify https://abcd1234.creeksandbox.com --json", "description": "Confirm the preview URL is live" },
    { "command": "creek status abcd1234", "description": "Check sandbox status" },
    { "command": "creek claim abcd1234", "description": "Claim as permanent project" }
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

Where it applies: a network failure of a Creek API or sandbox API call is `api_unreachable`, replacing the command's own error code. This holds whether the command reports the failure itself (env, domains, projects, db/storage/cache, rollback, logs, metrics, status, deployments, doctor, queue, claim, `creek deploy` to production) or leaves it to the CLI. Exception, for now: a sandbox `creek deploy` that loses the sandbox API reports `deploy_failed` without `retryable`. Treat that one as not retryable unless `creek status <sandboxId>` shows nothing was created. Self-host (`--server`, `--host`) commands report creekd's own errors.

MCP tools return the same `error` (the API's code), `message`, `status` and `details`.

`creek db|storage|cache create/attach/detach/delete` are safe to re-run. When the result is already in place they succeed (`ok: true`, exit 0) and say so: `alreadyExists: true` on `create` (with the existing `resource`) and `attach` (with the existing `binding`), `alreadyAbsent: true` on `detach` and `delete`. A fresh result carries `alreadyExists` / `alreadyAbsent: false`. A real clash still fails — see [resources](resources.md#re-running-commands).

`creek env rm` (alias `unset`) and `creek domains rm` follow the same rule. A key (or the `--target` value) that isn't set, or a hostname the project doesn't have, succeeds with `alreadyAbsent: true`, `removed: false` (`env rm` also `removedValues: 0`), including in `--dry-run` (`wouldExecute: false`) and when a concurrent removal wins. A fresh removal carries `alreadyAbsent: false`. Env vars and domains are deleted outright, so a key or hostname removed earlier and one never set (a typo) look the same: `alreadyAbsent: true` doesn't prove it existed. If you expected it, check the name with `creek env ls` / `creek domains ls`. Still errors: a missing project (`rm_failed` / `delete_failed`, `status: 404`), for `env rm` a key that can't exist, e.g. padded or lowercase (`invalid_key`, nothing sent), and for `domains rm` a string that isn't a hostname at all (`not_found`; padding and case are normalized). `env rm` keeps `pendingDeploy: true` on `alreadyAbsent`: an earlier run may have removed the key without a deploy since.

Env var values are write-only: `creek env ls --json` returns `vars[]` with `key` and `target` only (and `valuesWriteOnly: true`). No command or MCP tool returns a value. `--show` exits 1 with `values_write_only`. To change a value, `creek env set` it again.

### Deploy results name the deployment

Every `creek deploy --json` result carries `deploymentId` once a deployment exists — success, `deploy_failed`, `cancelled`, `timeout`, `verify_failed`, a cache hit (`turbo: true`) and `--from-github` — or `sandboxId` for a sandbox. Failures add `status`, `failedStep` and, when the server classified it, `errorCode` / `errorHint`. A deploy that is not over points at `creek deployments wait`:

```json
{
  "ok": false,
  "error": "timeout",
  "message": "CLI stopped waiting after 2m; the deploy may still be in progress",
  "deploymentId": "0b6f2c1e-…",
  "project": "my-app",
  "status": "deploying",
  "breadcrumbs": [
    { "command": "creek deployments wait 0b6f2c1e-… --json", "description": "Keep waiting for this deploy to finish (do not re-run deploy)" },
    { "command": "creek deployments logs 0b6f2c1e-… --json", "description": "View the build log so far" }
  ]
}
```

`creek deployments get <id> --json` and `creek deployments wait <id> --json` return the fields of the MCP `get_deployment` tool: `project`, `deploymentId`, `version`, `status`, `terminal` / `final`, `branch`, `commitSha`, `triggerType`, `failedStep`, `errorMessage`, `errorCode`, `errorHint`, `url`, `previewUrl`, `isProduction`, `createdAt`. `wait` adds `waitedMs`; on `error: "timeout"` it adds `retryable: true` — run the same command again. `wait` retries a dropped connection, a 5xx or a 429 until the timeout; a server error that lasts ends in `error: "api_error"` with `retryable: true` and the same `wait` as breadcrumb, a network failure in `api_unreachable`. A short id matches only the newest 20 deployments (`ambiguous_id` when it matches more than one); pass the full id otherwise.

`creek status --json` (a project) reports `productionDeploymentId`, the deployment production serves.

Dry-run `nextStep` is a copy-pasteable command (`creek deploy --sandbox --json` or `--prod`). Follow it; do not strip the flags.
