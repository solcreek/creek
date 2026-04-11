# @solcreek/cli

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
