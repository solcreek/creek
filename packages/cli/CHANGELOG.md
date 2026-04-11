# @solcreek/cli

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
