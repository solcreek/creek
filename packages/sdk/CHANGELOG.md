# @solcreek/sdk

## 0.4.25

### Deployments

- **`getDeployment(project, idOrPrefix)`** returns a `DeploymentView`: status,
  `terminal` / `final`, `failedStep`, `errorCode` / `errorHint`, `url`,
  `commitSha` and `branch`, the same fields as the MCP `get_deployment` tool.
  It takes a full id or the 8-char short id; `resolveDeploymentId` does the
  matching (404 `not_found`, 409 `ambiguous_id` with `details.matches`).
- **`waitForDeployment(project, idOrPrefix, { timeoutMs, intervalMs })`**
  polls until the deployment is final and returns `{ view, timedOut,
  waitedMs }`; a budget that runs out returns `timedOut: true` instead of
  throwing. A dropped connection, a 5xx or a 429 is retried until the
  deadline. `toDeploymentView` and `TERMINAL_DEPLOYMENT_STATUSES` are exported.
- **Deployment ids are validated before they go into a URL.** Anything but a
  uuid or a hex prefix of one throws `CreekApiError` 400 `invalid_id` with no
  request (`isDeploymentIdOrPrefix`). Project and deployment ids in deployment
  paths, `getDeploymentStatus` and `getBuildLog` included, are URL-encoded.
- **`Project`** gains `productionDeploymentId` and `createdAt`, the fields
  `GET /projects/:slug` actually returns.

### API keys

- **`getApiKeySelf()` / `revokeApiKeySelf()`** read and revoke the key the
  client authenticates with (`GET` / `DELETE /api-keys/self`). `ApiKeySelf`
  carries id, name, `start`, team, scopes, `effectiveScopes`, role, expiry and
  last use; no secret. **`isApiKeySelfUnsupported(err)`** recognises a server
  without the route (404, 405, `route_not_scoped`).

### Resources

- **`listResources({ includeDeleted: true })`** also lists deleted resources
  (`?include=deleted`), so a re-run delete can tell "already deleted" from
  "never existed".
- **`aliasPartner(name, type)`** returns the other name of a primary binding
  and its deprecated alias (`DATABASE` / `DB`, `CACHE` / `KV`).

### Compatibility

- **`createResource` no longer takes `cfResourceId` / `cfResourceType`.** The
  API rejects them: Creek always provisions the Cloudflare resource behind a
  new resource. TypeScript callers passing them fail to compile.

## 0.4.24

- **`CreekApiError.details`** holds an error response's fields beyond
  `error` and `message` — `required` / `granted` on `insufficient_scope`,
  `conflicts` on `binding_conflict`, `newBindings` on a preview's refusal.
  `uploadBuildLog` parses its error responses the same way, keeping
  `build_log_upload_failed` only when the body has no code.
- **`getSession()` returns null only when the API refuses the key** (401, or
  403 for a key it will not use). A network failure, a timeout or a 5xx now
  throws instead of reading as "not logged in".

## 0.4.23

- **A worker can have up to 4,999 modules.** `collectServerFiles` stopped at
  500, a limit with no basis: a 990-module build that Cloudflare accepts could
  not be deployed. The limit is now `WORKER_MODULE_LIMIT` (4,999, exported):
  a Workers upload takes at most 5,000 multipart parts, one of them the
  metadata. Past it, the error says so.
- **`collectServerFiles` counts modules as it goes** instead of re-counting the
  collected set for every file.

## 0.4.22

- **Environment variable targets.** New `EnvTarget` type
  (`"all" | "production" | "preview"`) and `ENV_TARGETS`. `setEnvVar` and
  `deleteEnvVar` take an optional `target`: `setEnvVar` sends it only when
  given (the server defaults to `"all"`), and `deleteEnvVar` without one removes
  every target's value. `listEnvVars` entries and the `setEnvVar` result carry
  `target`, absent from servers that predate targets. `deleteEnvVar` returns
  `removed`, the number of values deleted.
- **`deleteEnvVar` URL-encodes the key.**
- **`deleteResource` documents what deletion does**: the D1 database or KV
  namespace is deleted with its data, irreversibly, normally within minutes; an
  R2 bucket only if it is empty; refused (409) while a project binds it.

## 0.4.21

- **vinext.** `detectFramework` returns `"vinext"`, ahead of `next`, and
  `isSSRFramework` includes it; `creek.toml` accepts `framework = "vinext"`.
  `detectVinextBuild` / `parseVinextWorkerConfig` read vinext's Cloudflare build
  output (`.cloudflare/output/v0/workers/default/worker.config.json`): entry
  module, compatibility date and flags, KV / D1 / R2 / AI bindings, text vars,
  secrets, bindings Creek can't provide, and `runWorkerFirst`.
  `collectVinextServerFiles` collects its worker modules, `vinextBuildScript`
  picks `build:vinext` or `build`, and `resolveConfig` uses it for the default
  build command. `planDeploy` deploys the output in `worker` render mode.
- **Doctor.** New `CK-VINEXT-LEGACY-SETUP`, `CK-VINEXT-UNSUPPORTED-BINDINGS` and
  `CK-VINEXT-SECRETS`. Worker-entry checks skip vinext projects, and
  `CK-NOTHING-TO-DEPLOY` gives an unbuilt vinext project its own note.
- **`.assetsignore`.** `parseAssetsIgnore` and `applyAssetsIgnore` match
  gitignore patterns with the `ignore` package, the matcher Wrangler uses (new
  dependency).
- **`collectServerFiles` throws past `maxFiles`** instead of returning a partial
  set, and takes an `include` filter applied before files are counted.

## 0.4.20

- **`[release] migrations`** in `creek.toml`: `true` resolves to
  `ResolvedConfig.releaseMigrations` (default `false`). `[release] command` is
  now optional, so a project can turn on migrations without a command.
- **Migration discovery lives in the SDK.** Directory detection, file parsing
  and statement splitting moved here from the CLI, so remote builds collect
  migrations the same way. `collectMigrations(cwd, { strict })` throws, naming
  the file, when a migration cannot be read instead of skipping it.
- **`splitSqlStatements`**, a comment- and string-aware SQL splitter. It splits
  only on semicolons that end a statement — not inside `--` or `/* */`
  comments, quoted strings (with `''` escapes) or identifiers (`"…"`, backtick,
  `[…]`), or a `CREATE TRIGGER … BEGIN … END` body. Leading comments are
  dropped and comment-only fragments skipped.
- **SQLite dumps split correctly.** The dump splitter used to cut on any `;`
  before a newline, including one inside dumped string data or a comment. It
  now uses `splitSqlStatements` and strips comments anywhere in a statement,
  keeping its contract: bare statements, no comments.
- **`deprecatedAliasBindings`** returns, for a list of Worker bindings, a copy
  of each binding under its deprecated alias (`DATABASE` → `DB`, `CACHE` →
  `KV`), skipping alias names already taken. The new `@solcreek/sdk/bindings`
  subpath exports the binding names and this helper without the config module,
  so a Worker can import it without bundling zod or smol-toml.

## 0.4.19

- **Pre-bundled workers beside their assets.** `planDeploy` treats a built
  `.js`/`.mjs`/`.cjs` worker in a non-root directory that contains the asset
  output (e.g. `worker = "dist/worker.js"`, `output = "dist/assets"`) as
  upload-as-is, instead of wrapping and re-bundling it as source (which failed
  with `Could not resolve "creek"` for projects that don't depend on `creek`).
  The doctor's runtime-dependency rule uses the same definition.
- **`[build] run_worker_first`** in `creek.toml`: `true` or a non-empty list of
  route patterns, resolved into the config for `creek deploy` to send.
- **Custom-domain DNS records.** `DomainDnsInstruction` gains `apex` and
  `records` (`DomainDnsRecord`: type, name, value, purpose); `cname` stays.
  `ActivateDomainResult.status` gains `pending_edge`.

## 0.4.18

- **`CreekClient.planRollback`.** `GET /projects/:id/rollback` — same unbounded
  `triggerType != 'rollback'` selection as `POST /rollback`. Used by
  `creek rollback --dry-run` so the plan cannot disagree with execution when
  the 20-row deployments list is full of synthetic rollback rows.
