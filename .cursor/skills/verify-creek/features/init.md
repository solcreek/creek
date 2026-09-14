# init

`creek init` scaffolds a Creek project in the current working directory: writes `creek.toml` (`[project].name`, `[build]` command/output) and appends Creek + AI-agent entries to `.gitignore`. Non-interactive runs (`--json` / `--yes` / non-TTY) skip the database prompt unless `--db` is passed.

## Sub-features

- Empty dir: `creek init --json --yes <name>` → exit 0, `{ ok: true, name, path: "<cwd>/creek.toml", database: false, databasePromptSkipped: true }`, file `creek.toml` appears.
- Side effects: creates `.gitignore` when missing (`gitignoreAdded` lists entries including `.cursor`). Isolated to the disposable cwd.
- `--db` (not in the default drive): also writes `[resources] database = true`, `[build].worker`, and `worker/index.ts`.
- Existing `creek.toml`: `--yes` overwrites without prompting; without `--yes` on a TTY it confirms.

## How to get to it (user POV)

```bash
mkdir my-app && cd my-app
creek init --json --yes my-app
```

Init has no directory flag — it always uses `process.cwd()`. The positional argument is the project name (defaults to the sanitized directory basename).

## Driving it with drive.sh

```bash
.cursor/skills/verify-creek/scripts/drive.sh init
```

Creates `/tmp/creek-verify-$RUN_ID/projects/init`, runs `init --json --yes verify-init` there, asserts JSON `ok`/`name`/`database: false`/`databasePromptSkipped: true`, checks `creek.toml` contains `name = "verify-init"`, and asserts fixture `.gitignore` exists with a `.cursor` entry. Proof also records `side-effects.json` `filesAdded`.

Do not run init inside the monorepo root.

## Gotchas

- Non-interactive init without `--db` does not scaffold a worker; JSON breadcrumbs include `creek init --db`.
- `gitignoreAdded` includes `.cursor` — that is the **fixture** `.gitignore`, not the monorepo’s.
- Init does not declare `--dry-run` (`destructive: false`) but **does mutate the cwd**. Passing `--dry-run` is `unknown_flag`; that is not a preview of init.
- Self-host `--adopt` / `--hostkey-fingerprint` writes `~/.creek/hosts.json`. Helpers isolate HOME; still skip adopt unless a feature file is added with an explicit mock host.
