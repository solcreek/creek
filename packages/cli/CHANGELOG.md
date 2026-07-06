# @solcreek/cli

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
