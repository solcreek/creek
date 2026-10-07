# @solcreek/sdk

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
