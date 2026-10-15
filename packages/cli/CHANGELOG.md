# @solcreek/cli

## 0.4.55

Requires `@solcreek/sdk@0.4.25`. Publish `sdk@0.4.25` before `cli@0.4.55` /
`creek@0.4.55`.

This release changes several `--json` shapes and exit codes. Agents parsing
the old output should read [Compatibility](#compatibility) first.

### Which project

- **Every project command accepts `--project`** and finds its project the way
  `creek deploy` does: `--project`, else `creek.toml` `[project].name`, else
  the wrangler config's `name`, else the framework `package.json` `name`. This
  covers `env`, `deployments`, `domains`, `queue send`, `logs`, `metrics`,
  `rollback`, `status`, `db shell` / `migrate` and `doctor --last`. Before,
  most of them read only `creek.toml`, so `creek env set` in a wrangler-only
  project failed `no_project` while rejecting `--project`.
- **Project commands never use the directory name as the project.** A static
  site, a wrangler config without `name` or a `package.json` without `name`
  gives `no_project` with `foundConfig` (the file) and a message saying where
  to add a name. Results add `projectSource`: `flag`, `creek.toml`,
  `wrangler` or `package.json`.
- **`no_project`** names only `--project`, and its first breadcrumb is
  `creek projects --json`. A config that exists but cannot be parsed is
  `invalid_config` with the parser's diagnostic, here and in `creek deploy`.
- **`creek status --project <slug>`** works outside the project directory. It
  reports local config (bindings, cron, drift) only when the directory deploys
  as that project; otherwise `config` is `null` and bindings are empty.
- **Breadcrumbs are pasteable.** Follow-up commands add `--project <slug>`
  when the current directory would not resolve to that project, and never
  suggest a `creek deploy` that would ship a different project. Breadcrumbs
  that named flags a command lacks are fixed: `rollback --to` suggests
  `creek rollback <deployment-id>`, self-host rollback suggests
  `creek top --server <addr>`, and `restart` / `top` suggest
  `creek logs --server <url> --project <app-id>`.

### Deploy destination

- **`creek deploy --prod` never ends in a sandbox.** Signed out on a project
  it is `not_authenticated`, with `creek login --token <KEY> --json` and
  `creek deploy --sandbox --json` breadcrumbs. On a sandbox-only path
  (`creek deploy <dir>`, `--template`, a bare build-output folder) it is
  `prod_unsupported`, signed in or not. A bare `creek deploy` with no flag
  still falls back to a sandbox when signed out.
- **`--sandbox` never ends in production or creekd.** `--from-github --sandbox`
  and `--sandbox` on a creekd project (`target = "creekd"`) are
  `sandbox_unsupported`. `creek deploy <dir>` of a creekd project is
  `creekd_dir_unsupported`, with a `cd <dir> && creek deploy --yes --json`
  breadcrumb. A creekd project deploys with its own token, signed in or not.
- **`--dry-run` plans exactly what the run does**: `target.type` (`production`,
  `sandbox` or `creekd`) and `target.reason` come from the same decision the
  real run dispatches on.
- **`--sandbox` and `--dry-run` work with a saved key bound to another API**
  (see [API keys](#api-keys)); they never send it. `--prod` still refuses with
  `api_mismatch` before any request.
- **`--wait` applies to a cache hit.** The cache-hit poll waits up to `--wait`
  (default 2m) instead of a fixed 30s, and its timeout reports like any other.
- **A static site deploys `[build].output`.** A sandbox deploy with
  `output = "public"` next to a root `index.html` uploads `public/`.

### Follow a deploy by id

- **Every `creek deploy --json` result has `deploymentId`**: success,
  `deploy_failed`, `cancelled`, `timeout`, `verify_failed`, a cache hit,
  `--from-github` and an `upload_failed` the API refused. Failures add
  `status`, `failedStep` and `errorCode` / `errorHint`. A sandbox failure
  carries `sandboxId` once the sandbox exists.
- **`creek deployments get <id>`** reports status, `final`, `failedStep`,
  `errorCode` / `errorHint`, `url`, `commitSha` and `branch`. It takes the full
  id or the 8-char short id.
- **`creek deployments wait <id> [--timeout 2m]`** polls until the deployment
  is final: exit 0 when active; exit 1 with `deployment_failed` or
  `deployment_cancelled`; exit 1 with `error: "timeout"`, `retryable: true`
  and the last status when it is still running. A dropped connection, 5xx or
  429 is retried until the deadline.
- **`creek status <id>`** looks for a deployment of the project first, then a
  sandbox; `type` says which (`deployment` or `sandbox`). `creek status` now
  reports `productionDeploymentId` and `createdAt`, which were always missing.
- **A malformed deployment id is `invalid_id`** before any request (only a
  uuid or a hex prefix of one is accepted).
- **`--from-github` follows the triggered commit.** Results carry
  `matchedBy: "commit" | "newest_row"`. A stand-in row adds
  `commitMatched: false`, `expectedCommitSha` and `commitSha`. A deployment
  still running at the 15-minute cap is a `timeout`, not a failure.

### Safe re-runs

- **Resource commands converge.** Re-running `creek db|storage|cache create`,
  `attach`, `detach` or `delete` when the state already holds exits 0 with
  `alreadyExists: true` or `alreadyAbsent: true`; a fresh change reports
  `false`. A name held by another kind or by a deleted resource (names stay
  reserved), or a binding name held by another resource, is still an error
  and carries `details.existing`. `delete` of a name the team never had is
  still `not_found`; a missing project in `detach` is `detach_failed` with
  `details.missing: "project"`.
- **`creek env rm` / `env unset` and `creek domains rm`** of something already
  gone exit 0 with `alreadyAbsent: true`, `removed: false` (and
  `removedValues: 0` for env), also under `--dry-run`. Env vars are not
  tombstoned, so `alreadyAbsent` does not prove the key ever existed. A key
  that is not a valid env name is `invalid_key`, and a domain that is not a
  hostname is `not_found`, before any request.

### Environment variables

- **Env values are write-only.** `creek env ls --json` returns `key` and
  `target` per var plus `valuesWriteOnly: true`. The old `value` was a mask of
  the key name, never the value. `creek env ls --show` exits 1 with
  `values_write_only`.

### API keys

These use the `/api-keys/self` route from the Creek API (solcreek/creek#125),
already deployed.

- **`creek whoami --json`** reports `tokenSource` (`env:CREEK_TOKEN` or
  `config`) and `key`: `id`, `name`, `start`, `kind` (`legacy` | `scoped`),
  `team`, `scopes`, `effectiveScopes`, `role`, `access`, `expiresAt`,
  `expired`, `lastUsedAt`, and the legacy sunset `warning`. It warns when
  `CREEK_TOKEN` overrides a different saved key. A key the session check
  refuses but `/self` describes is `key_unusable`, not `session_expired`.
  Against an API without `/self`, `key` is `null` with `keyLookup`.
- **A saved key is bound to the API it was verified against.** `creek login
  --token` records it; every command then refuses to send that key to another
  API (`CREEK_API_URL` or the config's `apiUrl`) with `api_mismatch`,
  `savedKeyApiUrl` and `apiUrl`, before any request. A key saved by an older
  CLI is unbound and works as before; `whoami` reports
  `keyBinding: "bound" | "unbound"`. `CREEK_TOKEN` is never bound.
- **`creek login --token`** warns when `CREEK_TOKEN` will keep overriding the
  key it saves.
- **`creek logout`** (new) forgets the saved key and says it is still valid
  (`keyStillValid`, `keyPrefix`, `dashboardUrl`). **`--revoke`** revokes the
  active key: `revoked: true`, or `reason: "already_invalid"` on a 401. Any
  other outcome keeps the key, exits 1 and sets `mayHaveApplied: true`.
  `CREEK_TOKEN` set alongside a different saved key is
  `ambiguous_credentials`, with one pasteable command for each key.
- **`creek keys`** (new): `keys self` shows the active key, `keys revoke
  --self [--dry-run]` revokes it. `keys ls`, `keys create` and
  `keys revoke <id>` need a dashboard session: they return `session_required`
  and `dashboardUrl` without a request.
- **No output shows more of a key** than its prefix (`crk_sk_live_`,
  `crk_sk_test_`, `ck_`) plus 4 characters.

### JSON contract

- **Every `--json` result has `ok` as its first key**, and every failure has
  `error` and `message`.
- **`creek logs --json` is NDJSON with a summary.** Entry lines are
  `{"type":"entry", …, "projectSource"}`, and the stream ends with
  `{"ok":true,"type":"summary","project","projectSource","count","truncated"}`,
  so no entries prints `count: 0` instead of nothing. With `--follow`, a
  `type: "following"` line separates history from live entries.
- **An unreachable API is `api_unreachable` in every command**, with `reason`,
  `retryable` and, when a write may have been applied, `mayHaveApplied: true`.
  Before, commands that call the API directly returned their own code with
  `message: "fetch failed"`. API refusals keep the command's code with
  `status`, `apiError` and `details`.
- **`--help --json` comes from the command definitions.** `destructive` means
  the command may delete or overwrite data or change what is live; it is no
  longer "has `--dry-run`" (read `dryRun` for that). A command registered
  under several names is listed once with `aliases` (`env rm`, aliases
  `["unset"]`). `args[].enum` lists allowed values (`env --target`,
  `metrics --period`, `dev --target`).
- **`creek queue send` help** says a JSON body needs `--parseJson` (`-j`);
  `--json` is the output flag.

### Init

- **`creek init` no longer overwrites an existing `creek.toml` silently.** A
  non-interactive run exits `already_exists` with a `creek init --force --json`
  breadcrumb. `--force` replaces it; results carry `replaced`.
- **A plain static site gets a deployable config**: `command = ""` and
  `output = "."` (or `"public"`). JSON adds `staticSite` and `build`.
- **Agent configuration is no longer gitignored.** `init` adds only `.creek`
  and `.claude/settings.local.json`; `.claude`, `.cursor`, `.windsurf`,
  `.agents`, `.github/copilot*` hold team-shared rules and stay tracked.

### Compatibility

Changes that can break an agent parsing the 0.4.54 output:

- **Exit 1 becomes exit 0**: re-running resource `create` / `attach` /
  `detach` / `delete`, `env rm` and `domains rm` when the state already holds.
  Read `alreadyExists` / `alreadyAbsent`.
- **Exit 0 becomes exit 1**: `creek ops health` when a service is down (adds
  `error: "unhealthy"`), `creek env ls --show` (`values_write_only`), and
  non-interactive `creek init` over an existing `creek.toml`
  (`already_exists`).
- **`creek deploy --prod`** that used to deploy a sandbox now fails:
  `not_authenticated` signed out, `prod_unsupported` on a sandbox-only path.
  `--from-github --sandbox` and `--sandbox` on a creekd project are
  `sandbox_unsupported`; `creek deploy <dir>` of a creekd project is
  `creekd_dir_unsupported`.
- **Network failures** are `error: "api_unreachable"` instead of the
  command's code (`set_failed`, `api_error`, …).
- **`creek logs --json`** lines gain `type`; skip lines whose `type` is not
  `"entry"`. A final `summary` line is always printed.
- **`creek env ls --json`** drops `vars[].value`.
- **`creek verify --json`** failures are `error: "verify_failed"`; the old
  reason (`"HTTP 500"`, `"Missing: …"`) moved to `message`.
- **`creek ops <unknown> --json`** is `error: "unknown_command"` with the text
  in `message`. **`creek doctor --json`** with issues adds
  `error: "issues_found"`.
- **`--help --json`**: `destructive` is now `true` for `projects delete`,
  `db|storage|cache detach`, `db shell` / `seed`, `restart`, `stop` and `init`.
  `env` lists `rm` once with `aliases`.
- **Deploy timeout breadcrumbs** are `creek deployments wait <id> --json` and
  `creek deployments logs <id> --json` (were `creek status`). A sandbox failure
  suggests a retry only when `retryable: true`. `--from-github` failures gain
  `error` (`deploy_failed` or `cancelled`) next to `errorMessage`.
- **`creek status <8-char id>`** resolves to a deployment of the project before
  a sandbox with the same id.
- **A key saved by `creek login`** is refused with `api_mismatch` when
  `CREEK_API_URL` points at another API. Run `creek login` against that API,
  or use `CREEK_TOKEN`.
- **`no_project`** has a new message and a `creek projects --json` first
  breadcrumb; a config without a project name adds `foundConfig`.

## 0.4.54

Requires `@solcreek/sdk@0.4.24`, already published.

### Next.js

- **More Next.js apps deploy and run.** Deploys now build with
  `@solcreek/adapter-creek@0.2.24`. Before, each of these failed the build or
  returned 500:
  - a server action posted to an edge page;
  - a `.wasm` import in middleware or an edge route;
  - `experimental.serverSourceMaps`;
  - a Web Worker (`new Worker(new URL(...))`);
  - an `ImageResponse` from `next/og` in a node-runtime route, such as an
    `opengraph-image`;
  - a pages route that renders its own `RouterContext.Provider`.

  A soft navigation to a page under a route group (`app/(shop)/...`) no longer
  fails in the browser. An older adapter cached in `.creek` is replaced on the
  next deploy.

## 0.4.53

Requires `@solcreek/sdk@0.4.24`. Publish the SDK tag `sdk@0.4.24` before
`cli@0.4.53` / `creek@0.4.53`.

### Errors agents can act on

- **A refused API call keeps the API's error code and fields.** `--json`
  errors from the Creek API add `status`, `apiError` (e.g.
  `insufficient_scope`, `binding_conflict`) and `details` (e.g. the scopes a
  key lacks); `error` stays the command's own code. An error no command
  handled uses the API's code instead of `internal_error`, with no stack
  trace. Human output names the required and granted scopes.
- **A rejected key during `creek deploy --json`** prints
  `error: "unauthorized"` instead of an empty stdout. `creek status` and the
  GitHub deploy path report `not_found` only on a 404.
- **An unreachable server is `api_unreachable`**, with `reason` (the network
  cause, e.g. `ECONNREFUSED`, `ENOTFOUND`, a certificate error) and
  `retryable`. `retryable: true` means re-running the whole command is safe:
  the failure is transient and nothing the run changes can have been applied.
  `mayHaveApplied: true` means a write of this run (this request or an earlier
  step) may have been applied — check the result before running it again. A
  response that breaks off mid-body is classified the same way.

### Requests

- **Writes are sent without following redirects.** A redirected write now
  returns its 3xx instead of being followed. Creek's APIs never redirect a
  write; a `CREEK_API_URL` pointing at an `http://` address the edge
  redirects to `https://` now fails on writes.

### Next.js

- **Edge-runtime pages and routes work in Next.js deploys.** Deploys now build
  with `@solcreek/adapter-creek@0.2.22`. Before, every page or route with the
  Edge runtime (a pages API route with `runtime: "edge"`, an app route handler
  or page with `runtime = "edge"`, an edge pages SSR page) returned 500 "No
  handler function found on module", with or without middleware. An older
  adapter cached in `.creek` is replaced on the next deploy.

## 0.4.52

Requires `@solcreek/sdk@0.4.23`. Publish the SDK tag `sdk@0.4.23` before
`cli@0.4.52` / `creek@0.4.52`.

### Deploys

- **A worker can have up to 4,999 modules**, the most one Cloudflare upload
  carries, up from 500. vinext, Astro and the pre-bundled SSR frameworks
  (Nuxt, SvelteKit, SolidStart) deploy builds of up to that many modules; past
  it the deploy stops and says so.

## 0.4.51

Requires `@solcreek/sdk@0.4.22`.

### Environment variables

- **`creek env set --target production|preview|all`** stores a value for
  production deploys, preview (branch) deploys, or all of them (the default). A
  deploy uses its own target's value, else the `all` value. The CLI reports
  success only when the server stored the target asked for: on a server
  without targets, which stores the value for every deploy, it fails with
  `target_unsupported` and says how to undo it.
- **`creek env ls`** shows each value's target, and `--json` includes it.
- **`creek env rm --target <target>`** removes only that target's value;
  without `--target` it removes every value of the key, and `--json` reports
  `removedValues`. On a server without targets it refuses
  (`target_unsupported`) instead of deleting the all-deploys value.
- **`creek env set` says which deploys pick up the change**: the next deploy,
  production deploy or branch deploy.

## 0.4.50

Requires `@solcreek/sdk@0.4.21` (unchanged).

### Resources

- **Deleting a database or cache deletes its data, permanently.**
  `creek db delete` and `creek cache delete` now say that the Cloudflare
  database or namespace and all its data are deleted, normally within minutes,
  and that this cannot be undone. In an interactive terminal they ask for
  confirmation first; `--yes`, or a non-interactive run, skips the prompt.
- **`creek storage delete` says what happens to the bucket's objects.** Only an
  empty bucket is deleted. A bucket that still holds objects is not deleted and
  keeps them, so empty it first.

### Next.js

- **The build log names the build that runs:** `next build --webpack` with the
  Creek adapter. A Next.js deploy runs that in place of `[build] command` and
  the project's build script, and the dashboard build log now records it too.
- **An empty `[build] command` no longer skips the Next.js build.** Before, the
  deploy uploaded whatever a previous build had left in `.creek/adapter-output`.
- **`creek deploy --skip-build` says when the Next.js build it deploys was made**,
  for example `built 3 hours ago`.

### Admin

- **`creek ops deployments`** sends the API key the control plane reads, and
  reports a missing platform-admin role instead of a generic error.

## 0.4.49

Requires `@solcreek/sdk@0.4.21` (unchanged).

### Next.js

- **Workers with Chinese, Japanese, Korean or other non-Latin text use half
  the source memory.** Next.js deploys now build with
  `@solcreek/adapter-creek@0.2.20`, which keeps the worker source one byte per
  character in the isolate. Before, one such character left in a regular
  expression made a 33 MB worker take 66 MB of the 128 MB memory limit before
  serving a request. The build log reports the memory saved. An older adapter
  cached in `.creek` is replaced on the next deploy.

## 0.4.48

Requires `@solcreek/sdk@0.4.21` (vinext detection and build output,
`.assetsignore`). Publish the SDK tag `sdk@0.4.21` before `cli@0.4.48` /
`creek@0.4.48`.

### vinext

- **vinext apps deploy.** A project that depends on `vinext` is detected as
  vinext, ahead of `next` (which `vinext init` keeps), and builds with
  `build:vinext` when the project has one, else `build`. The deploy ships
  vinext's Cloudflare build output: the worker with its static assets, the
  compatibility date and flags it was built for, and the KV, D1, R2 and Workers
  AI bindings declared in `cloudflare.config.ts` under their own names. Text
  bindings become environment variables. Set the project up with
  `vinext init --platform=cloudflare`.
- **The deploy stops before uploading** when there is no build output, when the
  project uses vinext's legacy Wrangler setup, or when `cloudflare.config.ts`
  declares a binding Creek can't provide (the error names it). Workers AI must
  be bound as `AI`.
- **`creek deploy --dry-run` and `creek doctor`** show the bindings and
  compatibility settings from the last vinext build, and report the legacy
  Wrangler setup (`CK-VINEXT-LEGACY-SETUP`), bindings Creek can't provide
  (`CK-VINEXT-UNSUPPORTED-BINDINGS`) and secrets to set with `creek env set`
  (`CK-VINEXT-SECRETS`). Checks about a missing or undeclared worker entry no
  longer fire for vinext projects.
- **`creek init`** writes `framework = "vinext"` with vinext's build command and
  output, and `creek.toml` accepts that framework.
- **Sandbox deploys** warn that the database is temporary when it is declared
  only in `cloudflare.config.ts`.

### Deploys

- **`.assetsignore` is honoured** in the assets directory of every deploy,
  including `creek deploy <dir>`, with the gitignore patterns Wrangler uses.
  The files it lists, and the file itself, are no longer published.
- **The deploy names the worker's entry file** for vinext, Astro, Next.js
  (adapter builds) and workers Creek bundles, so that file runs rather than one
  picked by name. The production build log's detect line shows it.
- **A worker with more than 500 modules stops the deploy** with an error.
  Before, the upload left the rest out and the worker failed at runtime on the
  routes that needed them.
- **`--skip-build` deploys the local output.** On a clean checkout, a build-cache
  hit used to deploy the cached build instead. The build log now records
  `build skipped (--skip-build)` rather than the build command.

## 0.4.47

Requires `@solcreek/sdk@0.4.20` (`collectMigrations`, `splitSqlStatements`,
`[release] migrations`). Publish the SDK tag `sdk@0.4.20` before `cli@0.4.47` /
`creek@0.4.47`.

### Release migrations

- **`[release] migrations = true` ships migrations with production deploys.**
  `creek deploy` includes the project's migrations in the bundle and warns when
  none are found, listing every directory it checked. It also warns that
  `[release] command` does not run on Cloudflare deploys. With migrations on,
  the pending-migration check runs after the deploy settles, so it reports what
  is still pending rather than what the deploy applies.
- **An unreadable migration stops the deploy** before the project or deployment
  is created, exiting with `migration_unreadable` and naming the file.
- **Migration deploys skip the build cache**, whose hit would deploy without
  the job that applies migrations.

### Migrations and SQL

- **`db/migrations` is detected** by `creek db migrate`, the sandbox's
  migration seeding, and deploy's drift check. It is checked after
  `migrations/`, so a project with both keeps using `migrations/`.
- **Semicolons inside comments and strings no longer split statements** in
  `creek db migrate`, `creek db seed`, and sandbox seeding; a `;` in a comment
  or string literal used to send D1 broken fragments ("No SQL statements
  detected"). Drizzle's statement-breakpoint files are unaffected.

### JSON output (`--json`, or any non-TTY stdout)

- **`creek deploy` keeps its JSON result alone on stdout.** The Terms notice,
  other log output, the build's own output, npm's script banner and child
  processes' output now go to stderr. This also replaces the creekd path's
  stdio pipe, which could fail a large build with `ENOBUFS`.
- **An unhandled error answers with JSON**: `{ ok: false, error:
  "internal_error", message }` on stdout, exit 1, with the error still logged
  to stderr.
- **`creek deploy --template` reports results and failures as JSON** (invalid
  template name, template not found, invalid `--data`, dependency install), and
  removes the cloned template when the process exits.

### Templates

- **Template deploys run the template's build.** The template was deployed
  without its resolved config, so nothing was built and every template deploy
  failed with "nothing to deploy: build output dist not found".

### Next.js

- **Requires `@solcreek/adapter-creek` >= 0.2.19**; an older cached or pinned
  copy is reinstalled. Its size guard now checks Cloudflare's current limit, 64
  MiB uncompressed. Up to 0.2.18 it measured gzip against the retired 3 MB /
  10 MB limits, so it failed builds past 10 MB gzipped that now upload fine.

## 0.4.46

Requires `@solcreek/sdk@0.4.19` (`planDeploy` for pre-bundled workers,
`run_worker_first`). Publish the SDK tag `sdk@0.4.19` before `cli@0.4.46` /
`creek@0.4.46`.

### Deploying frameworks that ship their own Workers bundle

- **Code-split pre-bundled workers deploy whole** (#55). A pre-bundled worker is
  uploaded with every module its relative imports reach — static, re-export,
  side-effect and string-literal dynamic imports, plus `.json`, `.wasm` and
  other data modules — named by path from the entry's directory. Chunks inside
  the asset dir are no longer also served as static files. Imports are read
  with esbuild's parser, so import-like text in comments or strings is ignored.
- **Fails closed instead of shipping a broken worker.** An import that leaves
  the worker's directory, points at a missing file, or would be uploaded as
  `worker.js` (the entry's name) fails the deploy, naming the module and
  specifier.
- **`[build] run_worker_first`** in `creek.toml` (`true` or route patterns) is
  sent with the bundle when the project has its own worker; other render modes
  warn that it's ignored.

### Custom domains

- **`creek domains add` prints the API's records** instead of a hard-coded
  `cname.creek.dev`: the routing CNAME (now `cname.bycreek.com`) and, when there
  is one, the ownership TXT, each with what it's for. For an apex, the CNAME's
  purpose says to use CNAME flattening, ALIAS or ANAME. `--json` passes
  `verification.records` and `verification.apex` through.
- **`creek domains activate --json` reports `pending_edge`** as well as
  `pending_dns`, instead of always `pending_dns`: `pending_edge` means Creek
  couldn't register the domain with the edge yet (retry), not a DNS problem.

## 0.4.45

Requires `@solcreek/sdk@0.4.18` (`CreekClient.planRollback`). Publish the SDK
tag `sdk@0.4.18` before `cli@0.4.45` / `creek@0.4.45`.

### Agent experience

- **Unknown flags are rejected.** citty/mri used to drop them. `creek rollback --dry-run` on a CLI that did not declare `--dry-run` therefore executed a real rollback. JSON: `{ ok: false, error: "unknown_flag", flags }`. `--help --json` still works. `--yes` is only valid on commands that spread `globalArgs`, not as a global allow-list.
- **Implicit rollback skips `triggerType=rollback` rows.** A second `creek rollback` no longer targets the synthetic row created by the first. Dry-run `nextStep` names the real previous deploy id (via `GET /projects/:id/rollback`, not the 20-row list).

### Agent experience (previously unreleased)

- **`creek deploy --prod` JSON includes `proof`.** After a successful
  production deploy (including GitHub / turbo paths), the CLI GETs the
  URL. 2xx and 3xx count as live (a 302 to a login page is still a live
  site). Failed proof → `ok: false`, `error: "verify_failed"`, URL kept.
- **`creek --help --json` emits a command schema.** Nested paths work
  (`creek deploy --help --json`, `creek env set --help --json`). Commands
  that define `--dry-run` are marked `destructive: true`. Agents should
  read this instead of scraping human usage text.
- **`--dry-run` on mutating commands.** `creek rollback`, `creek db delete`
  (and storage/cache delete), `creek env set` / `env rm`, and
  `creek domains rm` preview `wouldExecute`, `sideEffects`, and a
  copy-pasteable `nextStep` without POSTing or DELETEing. Database delete
  reports remaining bindings and refuses `wouldExecute` until they are
  detached.
- **Non-TTY `creek login` without `--token` fails immediately** with
  `interactive_login_unsupported` instead of opening a browser or hanging
  on a prompt. Auth breadcrumbs lead with `creek login --token <KEY> --json`.
- **Non-TTY `creek deploy --dry-run` `nextStep` is copy-pasteable.** It now
  emits `creek deploy --sandbox --json` or `--prod --json` instead of a bare
  `creek deploy` that agents followed into `confirmation_required`.
- **`wouldDeploy` matches the real gate.** A `creek.toml` with no
  `package.json` and no `index.html` is `wouldDeploy: false` (previously true,
  then failed at `no_package_json`).
- **`creek verify <url>`.** GET a preview/production URL; `--json` reports
  status, title, ttfb, optional `--contains`. Sandbox deploy JSON attaches the
  same check as `proof` and breadcrumbs `creek verify`.
- **Init / login / env breadcrumbs** point at `--sandbox`/`--prod` instead of
  a bare `creek deploy`. Auth errors include a `message` field.

## 0.4.41

### Deploy reliability & diagnosability

- **`--wait <duration>`.** The CLI polled for a terminal deploy state for a
  fixed 2 minutes, then gave up — so an activation that legitimately ran longer
  reported "stopped waiting" and exited non-zero even though it succeeded,
  breaking CI. Pass `--wait 15m` (or `900s`, `2h`, or a bare millisecond count;
  clamped to [1s, 60m]) to extend the budget so automation observes the real
  outcome. The give-up message now reflects the actual budget.

- **Classified failure reason on a failed deploy.** A deploy that failed at the
  activation stage previously surfaced only free-text (often "Unknown error").
  It now shows a stable code + actionable hint — `Deploy failed at deploying
  [activation_timeout]: …` — and, in `--json`, `errorCode` + `errorHint` so an
  agent can branch on it. (Fixes a bug where the CLI read the failure fields
  under the wrong casing and always showed "Unknown error".)

- **Migration drift lands in the build log.** A pending-migration warning was
  printed to stdout only on a successful deploy; it now also lands in
  `creek deployments logs` at the detect stage for failed and background/CI
  deploys — bounded so a slow drift check can never block the deploy result.

## 0.4.40

### Next.js

- **Skips the broken adapter 0.2.13.** `@solcreek/adapter-creek@0.2.13`
  shipped worker minification on by default, which broke Prisma
  driver-adapter apps at runtime (`PrismaD1 is not a constructor`) — every
  D1-backed page, including Better Auth's session lookup, 500'd. The CLI now
  requires adapter ≥ 0.2.14 and force-reinstalls a cached 0.2.13, so a deploy
  pulls the fixed build (0.2.14, minify off by default) instead of reusing the
  broken one. If you're stuck on 0.2.13, upgrade the CLI and redeploy — or, to
  fix it without a CLI upgrade, remove `.creek/node_modules` so the next deploy
  reinstalls the adapter.

## 0.4.39

### Agent- & CI-friendly failures

- **A failed deploy now fails loudly.** In `--json` mode (auto-enabled for
  CI, pipes, and agents) a build or plan error emits a structured
  `{ ok: false, error, message }` on stdout instead of only a human line, and
  a server-side "turbo" cache deploy that fails or times out exits non-zero
  instead of returning as if it succeeded. Build/bundle progress no longer
  leaks onto stdout in JSON mode, so the final JSON stays parseable.
- **Structured errors across the board.** `domains`, `env`, `queue`,
  `rollback`, `projects`, `db`/`cache`/`storage`, and `claim` now emit
  `{ ok: false, error, message }` on their common failures (not authenticated,
  no `creek.toml`, a malformed `creek.toml`, an API error, a missing resource)
  rather than human-only text or an unstructured crash.

### Migrations

- **Migration-drift is correct for projects that bind more than one D1.**
  Deploy now evaluates every bound database and reports against the most
  up-to-date one, so an empty spare no longer triggers a phantom "N migrations
  pending" on every deploy. A bound database that genuinely lags the others is
  called out so a lagging production DB isn't silently hidden.

## 0.4.38

### Bindings

- **Resource binding env vars now match your `creek.toml` keys.** `database`
  binds `env.DATABASE`, `cache` binds `env.CACHE`, `storage` binds
  `env.STORAGE`. The older `env.DB` and `env.KV` names still resolve during the
  deprecation window and will be removed in v1.0 (see `ROADMAP.md`).
- **Declaring more than one database, namespace, or bucket now binds all of
  them.** Previously only the first resource of each kind reached the worker and
  the rest were dropped silently; `creek dev` now wires them all locally too.

## 0.4.37

### Deploy

- **`creek deploy` now asks before publishing to production.** When you're
  signed in, a bare `creek deploy` in an interactive terminal confirms the
  target ("Deploy <project> to PRODUCTION?") before touching your team's
  permanent URL, so a deploy you meant as a preview can't reach production
  by accident. Decline and nothing is published.
- **New `--prod` and `--sandbox` flags make the target explicit.** Pass
  `--prod` to publish to production with no prompt, or `--sandbox` to deploy
  to an ephemeral 60-minute preview even while signed in. The two are
  mutually exclusive. `creek deploy --dry-run` reports which target it would
  use, including when production is only implied by being signed in.
- **In non-interactive runs (CI, agents, pipes), `--prod` or `--sandbox`
  now states intent.** The "nothing happens without confirmation" guidance
  points at these flags so an automated deploy declares where it's going.
- **Deprecation:** relying on being signed in to mean "production" (without
  `--prod`) is deprecated. In a non-interactive run (`--yes`, `--json`, or a
  pipe) it still deploys to production but prints a warning to stderr, so
  `--json` stdout stays clean; in an interactive terminal you're asked to
  confirm the production target instead. A future version will require
  `--prod` — pass it to opt in now, or `--sandbox` to preview.

### Diagnostics

- **`creek deploy --dry-run` now flags a missing `creek` runtime dependency
  before bundling.** A worker that imports `creek` but doesn't list it in
  `dependencies` used to fail deep inside the bundler with an opaque
  `Could not resolve "creek"`; the dry-run now reports the missing package
  up front so you can `npm install creek` before deploying.
- **New compatibility check for Node HTTP-server stacks.** `creek doctor`
  (and `creek init`) now warns when a project depends on a server framework
  that expects a long-running Node process — Express, Fastify, Koa, Hapi,
  restify — which doesn't run on Workers, and points you at Hono as the
  Workers-native equivalent.
- **`creek init` surfaces stack-compatibility blockers up front.** Before
  writing `creek.toml`, init runs the relevant doctor checks and prints any
  hard incompatibilities (with a `creek doctor` breadcrumb), so an
  unsupported stack is caught at scaffold time instead of at deploy time.
- Corrected the wording of the runtime lock-in doctor advice.

### Routing

- **Deep links work in worker + static-assets mode.** Refreshing or sharing
  a client-routed URL (e.g. `/dashboard/settings`) now serves the SPA shell
  instead of returning 404. The fallback fires only on browser navigations
  (an HTML document request) — `/api/*` and non-document requests are
  unaffected, so API routes still return their real responses.

### Database

- **`creek db migrate` infers the target database from your project
  config.** You no longer have to pass the database name explicitly when the
  project declares one; an explicit `--project` is still honored.
- **Clearer error when a project's resource bindings can't be resolved.**
  `creek db` now returns a structured `project_lookup_failed` error instead
  of surfacing a raw lookup failure.

### Docs

- Added a full `creek.toml` configuration reference table to the CLI docs,
  documented the `s3` storage driver, and corrected the deploy-target /
  `--sandbox` override documentation.

## 0.4.36

### Fixes / DX

Deploy & init:

- **`creek init --db` lists the worker's dependencies as an explicit
  install step before deploy.** The scaffolded `worker/index.ts` imports
  `hono`, `creek`, and `d1-schema`; init now surfaces `npm install hono
  creek d1-schema` ahead of `creek deploy` in both the human output and the
  `--json` breadcrumbs (with a `workerDependencies` field), so the
  scaffold-then-deploy path no longer fails at bundle time. Previously the
  hint only appeared in interactive runs.
- **`creek init` discloses the `.gitignore` entries it adds.** Init appends
  Creek + AI-agent ignore entries; it now reports them in the output and a
  new `gitignoreAdded` `--json` field instead of editing `.gitignore`
  silently.
- **`creek deploy --json` keeps stdout free of human progress banners,** so
  the output is always valid JSON for scripts and agents.
- **`creek deploy` hints about same-origin APIs.** When one worker serves
  both the SPA and the API, it points you at relative API paths — the build
  runs without `VITE_API_URL`, so a hardcoded dev fallback would break in
  the browser.
- **`creek deploy` warns that a sandbox database is ephemeral.** Each
  sandbox deploy provisions a fresh, empty D1 that resets on redeploy; sign
  in for a persistent production database.
- **`creek claim` is clear that it only reserves the project.** No
  deployment or sandbox data carries over, and `creek deploy` is required —
  surfaced in the human output and `--json` (`deployed: false`,
  `productionDeploymentId: null`).

Doctor:

- **`creek doctor` flags worker imports missing from `package.json`** (for
  example the init scaffold's `hono`/`creek`/`d1-schema` before install),
  instead of reporting a clean bill of health before a deploy that can't
  bundle.
- **`creek doctor` warns when a sibling backend won't be deployed.** A
  `server/`, `mcp/`, or `backend/` directory with no declared worker entry
  is flagged, since the deploy ships a single worker plus static assets.

Day-2 operations:

- **`creek env unset` is accepted as an alias of `creek env rm`.**
- **`creek env set`/`rm` signal that the change is pending a deploy** in
  `--json` (`applied: false`, `pendingDeploy: true`) — env vars apply at
  deploy time, not on the running worker until you redeploy.
- **`creek db shell` accepts `--project`** to open the database bound to a
  project instead of requiring its generated name, and defaults to the
  project in `./creek.toml`.
- **`creek projects delete` removes a project** (the SDK gains
  `deleteProject`). Team-owned databases and buckets are left intact.
- **Unknown or incomplete commands return a structured JSON error** on
  stdout with a non-zero exit under `--json` or in non-interactive use,
  instead of printing usage text that breaks JSON parsing.

## 0.4.35

### Sandbox

- **Sandbox previews seed their ephemeral D1 with your migrations.** A
  `--sandbox` deploy now ships the project's migrations in the bundle and
  applies them to the throwaway database, so a preview reflects your current
  schema instead of an empty one.

## 0.4.34

### Sandbox

- **Wider deploy windows for asset-heavy apps.** Raised the sandbox
  deploy/activation timeouts so a project with many static assets isn't killed
  mid-upload.

## 0.4.33

### Deploy

- **Large sandbox uploads are compressed and given more time.** Bundle uploads
  to a sandbox are gzipped and the activation poll timeout was raised, fixing
  the deterministic "Sandbox deploy timed out" on asset-heavy projects.

## 0.4.32

### Next.js

- **Requires adapter ≥ 0.2.12**, which forces the fix that never scans a stale
  `.next/dev` build into the worker bundle (the cause of a multi-hundred-MB
  `worker.js` and "Payload Too Large" at upload).
- **Prisma is detected from your declared dependencies**, not module
  resolution, so the Prisma-on-D1 build path fires reliably.

## 0.4.31

### Next.js

- **Only reuses a cached adapter ≥ 0.2.10** from `.creek`, so a stale
  lazily-installed adapter can't slip through and produce an oversized worker.

## 0.4.30

### Deploy

- **Database preflight before deploy.** Deploy generates the Prisma client
  automatically and runs a database preflight, so schema/client problems
  surface before the upload instead of as a runtime error afterward.

## 0.4.29

### Migrations

- **`creek db migrate` detects Prisma's nested layout**
  (`prisma/migrations/<name>/migration.sql`), not just flat `.sql` files.

## 0.4.28

### Next.js

- **Lazily installs `@prisma/adapter-d1`** for Prisma-on-D1 builds, so you
  don't have to add it by hand.

## 0.4.27

### Next.js

- **Deploys with the compatibility date/flags the adapter declared**, instead
  of a hardcoded default that could drift from what the worker was built
  against.

## 0.4.26

### Next.js

- **The adapter build completes under the lazy install.** Fixed the worker
  bundling step that couldn't find `wrangler` when npm hoisted it to the top of
  `.creek/node_modules`.

## 0.4.25

### Next.js

- **Forces adapter ≥ 0.2.1 and invalidates stale `.creek` installs**, so a
  cached older adapter can't break the build.

## 0.4.24

### Fixes / DX

- **`creek init --db` adds a database without prompting.** Non-interactive
  runs (CI, coding agents) previously skipped the "Add a database?"
  question silently and produced a config without one. With `--db`, init
  writes `[resources] database = true` and `[build].worker`, and scaffolds
  the worker/index.ts example. When the prompt is skipped, init now says
  so and points at `--db` (`--json` output gets a `databasePromptSkipped`
  field and a breadcrumb).

- **`creek init <name>` sets the project name.** The positional name was
  ignored and the directory basename used instead; `--name` was the only
  working form.

- **`creek doctor` catches the resources-without-worker mismatch.** Two new
  findings: declaring resources with no worker entry (the deploy would be a
  static SPA where `/api/*` serves index.html — warn), and a worker file on
  disk that no config points at, so it would never deploy (info).

- **`creek deploy` warns before shipping a static SPA that declares
  resources**, naming the bindings and pointing at `[build].worker` — the
  same mismatch doctor flags, surfaced even when doctor never ran.

- **The "nothing to deploy" finding now presents both fixes.** Build output
  and worker entry are separate inputs; the guidance previously steered
  only toward re-running the build, leaving API-route projects chasing the
  wrong one.

## 0.4.23

### Fixes / DX

- **`creek init` help now lists what it creates** — creek.toml (project
  name, build command/output, detected framework) plus a worker/index.ts
  example when you add a database — so first-timers know what to expect.

- **`creek doctor --json` prints a one-line summary to stderr** when a human
  is watching, instead of only a wall of JSON. stdout stays pure JSON for
  agents and pipes; CI / redirected runs stay silent.

- **The two SQLite doctor findings cross-reference each other.** A project
  with both better-sqlite3 and Prisma no longer reads as two unrelated
  problems — each notes it's the same Cloudflare-Workers SQLite migration.

- **`creek db/storage/cache attach --to` shows a value placeholder** in its
  usage (`--to=<project>`) instead of a bare `--to`.

## 0.4.22

### Fixes / DX

- **Next.js deploys now set up the Creek adapter automatically.** Deploying
  a Next.js (≥ 16.2.3) project no longer requires installing or configuring
  anything — `creek deploy` fetches and runs the adapter on first use.
  Projects outside the Creek repo previously fell back to an older build
  path without it.

- **`creek deploy` no longer publishes from a non-interactive shell without
  `--yes`.** In CI, an AI coding agent, or a pipe there is no prompt to
  confirm, so a bare `creek deploy` now refuses and points you at
  `--dry-run` (preview the plan) or `--yes` (confirm and deploy) instead of
  shipping on its own. Interactive (terminal) use is unchanged.

- **Clearer Next.js diagnostics.** `creek doctor` and `creek deploy
  --dry-run` no longer tell you to run `next build` to produce output that
  Creek generates itself at deploy time, and the reported build-output path
  now matches what actually ships.

## 0.4.6

### Features

- **`creek deploy gh:owner/repo` shorthand** — a shorter alias for
  `https://github.com/owner/repo`. Matches the GitHub CLI convention.
  `gh:`, `gl:` (GitLab), and `bb:` (Bitbucket) are now all registered
  alongside the longer `github:` / `gitlab:` / `bitbucket:` forms.
  Example: `npx creek deploy gh:jiseeeh/serene-ink`.

### Fixes / DX

- **Install size cut from ~170MB to ~25MB** by moving `miniflare` out of
  runtime dependencies entirely. Miniflare plus its transitive deps
  (workerd, sharp) was adding ~146MB to every `npm install creek` — a
  pure penalty on the `creek deploy` flow, which never touches
  miniflare. `miniflare` is now listed in `devDependencies` only, so
  the published package is free of it. First-time `npx creek deploy`
  goes from ~20s install to ~3–5s, and the postinstall warnings that
  used to appear on systems without build tools (sharp's node-gyp
  fallback) are gone entirely.

- **`creek dev` loads miniflare from multiple locations** via
  `createRequire` — the user's current project (`npm install --save-dev
  miniflare`), a creek-managed cache directory at `~/.creek/deps`, or
  the global npm root (`npm install -g miniflare`). If none of those
  have it, a jargon-free error explains what to install and where.
  Users who only want to deploy never see this error because
  `creek deploy` doesn't load the local runtime at all.

## 0.4.5

### Features

- **`creek deploy --dry-run`** — new flag that reports a plan without
  executing: resolved config source, detected framework, build command,
  build output, bindings, cron/queue triggers, auth status, and the
  target type (sandbox vs production). No network calls, no file
  uploads, no ToS prompt, no build. Pair with `--json` for a
  machine-readable plan. Safe to call from an AI coding agent that
  wants to understand `creek deploy` behavior before running it.
  Unsupported modes (`--template`, `--from-github`, repo-url) short-
  circuit with a clear "not yet supported" message.

- **Static-site sandbox fast path** — `creek deploy` in a directory
  that contains only `index.html` (no `package.json`) now works. The
  SDK falls back to the `index.html` source and `deploySandbox`
  recognizes that case and delegates straight to `deployDirectory`,
  which uploads the cwd as-is. Previously crashed with an ENOENT on
  package.json. The simplest possible onboarding now works end-to-end:

      mkdir hello && cd hello
      echo '<h1>Hi</h1>' > index.html
      npx creek deploy

- **Astro framework support** — any Astro 3+ project (SPA, SSG, MDX,
  content collections) auto-detects and builds via `astro build`.
  Tested end-to-end against Astro 6 + Tailwind 4 + sharp image
  optimization (`jiseeeh/serene-ink` blog theme). Via the existing
  repo-URL flow, `npx creek deploy https://github.com/user/astro-theme`
  now works with zero Creek-side configuration.

- **Richer `creek deploy --help`** — `meta.description` and every arg
  description rewritten to spell out sandbox-vs-production behavior,
  auto-detection chain, safety notes around `--dry-run`, and example
  invocations. Primary audience is AI agents reading `--help` output
  on a cold paste, which shows up concretely as better self-description
  in the first tool call.

### Fixes

- `NO_PROJECT_BREADCRUMBS`, the sandbox-status not-found hint, and
  deploy.ts error paths now point to
  `creek deploy --template landing` instead of the non-existent
  `--demo` flag. Matching doc scrub across README, docs, llms.txt,
  and the pricing page.

## 0.4.4

### Features

- **`creek deploy --from-github [--project <slug>]`** — trigger a deploy
  of the latest commit on a project's production branch via its
  stored GitHub connection, skipping the local build entirely. Same
  server code path that a real `git push` webhook uses — runs in
  remote-builder, deploys via the existing pipeline, posts commit
  status. Use `--project` to target by slug or UUID, or omit it to
  infer from `creek.toml` in the current directory.

  Flow: the CLI snapshots the newest existing deployment, POSTs
  `/github/deploy-latest`, then polls `/projects/:id/deployments`
  every 1.5–2s to pick up the new row (handlePush runs in
  `waitUntil` on the server, so the row appears a beat after the
  trigger). Streams status transitions to the terminal until the
  deployment settles on `active`, `failed`, or `cancelled`. Hard
  cap of 15 minutes. `--json` prints a single structured result.

  Pairs with the dashboard's new "Deploy latest" button on the
  project detail page — both call the same endpoint.

## 0.4.3

- Cron/queue trigger support flowed through the deploy pipeline
  (bump commit `c1110b1`).

## 0.4.2

- Bundled with the queue binding + worker wrapper work landed in
  `@solcreek/runtime` 0.4.0 (bump commit `28fdb11`).

## 0.4.1

- Bump alongside `@solcreek/sdk` 0.4.0 (semantic resource names in
  `creek.toml`).

## 0.4.0

- Version bump ahead of the cron trigger pipeline work.

## 0.3.9

- First tagged release via the publish-cli GitHub Actions workflow
  (the workflow has been dormant since; 0.4.x went out via manual
  `pnpm publish` until 0.4.4 restored automated releases).
