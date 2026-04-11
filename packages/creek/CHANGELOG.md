# creek

The umbrella package — re-exports [`@solcreek/cli`](../cli/CHANGELOG.md)
under the `creek`/`ck`/`crk` binaries and [`@solcreek/runtime`](../runtime)
under `/react` and `/hono` subpaths.

## 0.4.2

### Changes

- Bundles `@solcreek/cli@^0.4.5` and `@solcreek/sdk@^0.4.2`. The CLI
  bump brings: `creek deploy --dry-run` for agent-safe plan preview,
  first-class Astro framework detection so `npx creek deploy <astro-repo-url>`
  just works, a static-site fast path so `echo '<h1>Hi</h1>' > index.html
  && npx creek deploy` finally doesn't crash on the missing package.json,
  and a full doc scrub replacing the dead `--demo` flag with
  `creek deploy --template landing`. See
  [`@solcreek/cli@0.4.5`](../cli/CHANGELOG.md) for the full list.

## 0.4.1

### Changes

- Bundles `@solcreek/cli@^0.4.4` — this is the important bump. 0.4.4
  adds `creek deploy --from-github [--project <slug>]`, which skips
  the local build and triggers a remote deploy of the project's
  latest production-branch commit via its stored GitHub connection.
  End users who install via `npm install creek` (or `npx creek`)
  were pinned to `@solcreek/cli@0.4.3` before this release and did
  not have the flag.

### Internal

- Switched the `@solcreek/cli` + `@solcreek/runtime` dependency
  specifiers from loose version ranges (`>=0.3.7`, `^0.2.3`) to
  `workspace:^`. pnpm rewrites this to `^X.Y.Z` at publish time
  using the workspace's current versions, which both keeps local
  development honest (the umbrella's `bin.js` now loads the
  in-tree CLI instead of whatever old version pnpm happened to
  pull from the store) and tightens the published constraint.

## 0.4.0

- Previous release. Loose dep ranges meant end users may have
  received any 0.3.x – 0.4.x CLI depending on install time.

## 0.3.12

- Last release before the 0.4.x line.
