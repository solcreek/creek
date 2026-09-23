# Initialize a project

Init writes `creek.toml` (and optionally a worker scaffold) into the current directory, discloses `.gitignore` mutations, and does not require a Creek account.

## Sub-features

- `init-toml` writes `creek.toml` with the given project name.
- `init-gitignore` appends Creek + AI-agent entries and lists them as `gitignoreAdded`.
- `init-no-db` skips the database prompt in non-interactive runs and breadcrumbs `creek init --db`.
- `init-db` writes `[resources] database = true`, `[build].worker`, and `worker/index.ts`.
- `init-overwrite` with `--yes` overwrites an existing `creek.toml` without a prompt.

## How to get to it (user POV)

- Run `creek init` in a project directory.
- Run `creek init <name>` to set the project name.
- Run `creek init --db` to add a database without a prompt.
- Run `creek init --yes` to skip the overwrite prompt. A non-TTY skips it as well. `--json` selects the JSON body and skips the database question. On a TTY, `--json` still asks before overwriting `creek.toml`.

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports a clean isolated home.
- `$VERIFY_CREEK_WORK` has no `creek.toml` yet.
- Drive with `--cwd "$VERIFY_CREEK_WORK"`.

- **Named init.** Create a project. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/init/named -- init verify-fixture --yes --json`. Exit code `0`. stdout JSON has `ok: true`, `name: "verify-fixture"`, `database: false`, `databasePromptSkipped: true`, and `path` ending in `creek.toml`.
- **File on disk.** Read `$VERIFY_CREEK_WORK/creek.toml`. It contains `name = "verify-fixture"` and a `[build]` table. It does not contain `worker =` or `[resources]`.
- **Gitignore disclosure.** Same JSON: `gitignoreAdded` is an array that includes `.creek`. `$VERIFY_CREEK_WORK/.gitignore` exists and contains `.creek`. Copy both files into the evidence directory.
- **No-db breadcrumb.** Same JSON: `breadcrumbs` contains a command `creek init --db`. `workerDependencies` is absent. `$VERIFY_CREEK_WORK/worker` does not exist.
- **Database scaffold.** In a second empty directory (or after removing `worker/` and re-init with `--yes`), run `creek.sh "$RUN_ENV" --cwd "$VERIFY_CREEK_WORK" --evidence .cursor/skills/verify-creek/artifacts/init/db -- init verify-fixture --db --yes --json`. Exit code `0`. JSON has `database: true` and `workerDependencies: ["hono","creek","d1-schema"]`. `$VERIFY_CREEK_WORK/worker/index.ts` exists. `creek.toml` contains `worker = "worker/index.ts"` and `database = true`. Copy `worker/index.ts` into the evidence directory.
- **Proof.** Evidence includes stdout JSON plus the written `creek.toml`, `.gitignore`, and (for `--db`) `worker/index.ts`. `$HOME/.creek/config.json` is still absent.

## Gotchas

- Non-interactive runs skip "Add a database?" unless `--db` is passed. Assert `databasePromptSkipped: true` on the no-db path; do not treat a missing worker as a bug.
- `init` does not `npm install` worker dependencies. When `--db` creates `worker/index.ts`, the first breadcrumb is `npm install hono creek d1-schema`, ahead of `creek deploy --sandbox --json`, and `workerDependencies` is `["hono","creek","d1-schema"]`. When `worker/index.ts` already exists, `--db` still sets `database = true` and `worker = "worker/index.ts"` in `creek.toml`, and the JSON omits `workerDependencies` and the install breadcrumb.
- `--yes` overwrites `creek.toml`. Re-running in the same work directory mutates the previous proof files; copy them out first.
- `--adopt` / `--hostkey-fingerprint` is the self-host registration path and writes `hosts.json` under `HOME`. It is not this feature.
