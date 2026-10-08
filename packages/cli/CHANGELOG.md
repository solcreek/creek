# @solcreek/cli

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
