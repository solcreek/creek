# Initialize a project

Init writes `creek.toml` (and optionally a worker scaffold) into the current directory, discloses `.gitignore` mutations, and does not require a Creek account.

## Sub-features

- `init-toml` writes `creek.toml` with the given project name.
- `init-gitignore` appends Creek's local-state entries (`.creek`, `.claude/settings.local.json`) and lists them as `gitignoreAdded`. Agent configuration directories (`.claude`, `.cursor`, `.github/copilot*`, …) are never ignored.
- `init-no-db` skips the database prompt in non-interactive runs and breadcrumbs `creek init --db`.
- `init-db` writes `[resources] database = true`, `[build].worker`, and `worker/index.ts`.
- `init-overwrite` refuses an existing `creek.toml` in a non-interactive run (`--json`, `--yes`, non-TTY) with `already_exists`; `--force` replaces it and the JSON says `replaced: true`.
- `init-static` writes `command = ""` and `output = "."` (or `"public"`) for a directory with `index.html` and no `package.json`, and reports `staticSite: true`.

## How to get to it (user POV)

- Run `creek init` in a project directory.
- Run `creek init <name>` to set the project name.
- Run `creek init --db` to add a database without a prompt.
- Run `creek init --force` to replace an existing `creek.toml`. Without it, an interactive terminal asks first; `--yes`, `--json` and a non-TTY refuse with `already_exists`. `--json` selects the JSON body and skips the database question.

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports a clean isolated home.
- `$VERIFY_CREEK_WORK` has no `creek.toml` yet.
- Drive with `--cwd "$VERIFY_CREEK_WORK"`.

- **Named init.** Create a project. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/init/named -- init verify-fixture --yes --json`. Exit code `0`. stdout JSON has `ok: true`, `name: "verify-fixture"`, `database: false`, `databasePromptSkipped: true`, and `path` ending in `creek.toml`.
- **File on disk.** Read `$VERIFY_CREEK_WORK/creek.toml`. It contains `name = "verify-fixture"` and a `[build]` table. It does not contain `worker =` or `[resources]`.
- **Gitignore disclosure.** Same JSON: `gitignoreAdded` is `[".creek", ".claude/settings.local.json"]`. `$VERIFY_CREEK_WORK/.gitignore` exists, contains `.creek`, and has no `.claude`, `.cursor` or `.github/copilot*` line. Copy both files into the evidence directory.
- **No-db breadcrumb.** Same JSON: `breadcrumbs` contains a command `creek init --db`. `workerDependencies` is absent. `$VERIFY_CREEK_WORK/worker` does not exist.
- **Database scaffold.** In a second empty directory (or after removing `worker/` and re-init with `--yes`), run `creek.sh "$RUN_ENV" --cwd "$VERIFY_CREEK_WORK" --evidence .cursor/skills/verify-creek/artifacts/init/db -- init verify-fixture --db --yes --json`. Exit code `0`. JSON has `database: true` and `workerDependencies: ["hono","creek","d1-schema"]`. `$VERIFY_CREEK_WORK/worker/index.ts` exists. `creek.toml` contains `worker = "worker/index.ts"` and `database = true`. Copy `worker/index.ts` into the evidence directory.
- **Overwrite refused.** In a directory whose `creek.toml` you wrote by hand (e.g. `[project]\nname = "keep-me"\n\n[resources]\ncache = true\n`), run `-- init demo --yes --json` into `artifacts/init/overwrite-refused`. Exit code `1`. JSON has `ok: false`, `error: "already_exists"`, and a breadcrumb `creek init --force --json`. `creek.toml` is byte-for-byte unchanged.
- **Overwrite forced.** Same directory, `-- init demo --force --json`. Exit code `0`. JSON has `ok: true`, `replaced: true`; `creek.toml` now has `name = "demo"`.
- **Static site.** In a directory with only `index.html`, run `-- init static-site --json`. Exit code `0`. JSON has `staticSite: true` and `build: {command: "", output: "."}`; `creek.toml` has `command = ""` and `output = "."`. `-- deploy --sandbox --dry-run --json` from there reports `config.source: "creek.toml"`, `buildOutput: "."`, `wouldDeploy: true`. Signed in against the local control-plane (`VERIFY_CREEK_FAKE_CLOUDFLARE=1`, see [Deploy bindings](deploy-bindings.md)), `-- deploy --prod --json` leaves the deployment `active` (the exit is `verify_failed`, as there); the old init config (`npm run build` / `dist`) in the same kind of directory exits `nothing_to_deploy`.
- **Proof.** Evidence includes stdout JSON plus the written `creek.toml`, `.gitignore`, and (for `--db`) `worker/index.ts`. `$HOME/.creek/config.json` is still absent.

## Gotchas

- Non-interactive runs skip "Add a database?" unless `--db` is passed. Assert `databasePromptSkipped: true` on the no-db path; do not treat a missing worker as a bug.
- `init` does not `npm install` worker dependencies. When `--db` creates `worker/index.ts`, the first breadcrumb is `npm install hono creek d1-schema`, ahead of `creek deploy --sandbox --json`, and `workerDependencies` is `["hono","creek","d1-schema"]`. When `worker/index.ts` already exists, `--db` still sets `database = true` and `worker = "worker/index.ts"` in `creek.toml`, and the JSON omits `workerDependencies` and the install breadcrumb.
- Re-running init in the same work directory now exits `already_exists` unless you pass `--force` (which mutates the previous proof files; copy them out first). A CLI before this change overwrote silently with `--yes` or in a non-TTY.
- `--adopt` / `--hostkey-fingerprint` is the self-host registration path and writes `hosts.json` under `HOME`. It is not this feature.
