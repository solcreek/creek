# help-schema

Machine-readable `creek --help --json` is the command tree agents must use instead of scraping human usage. Root and leaf schema include `dryRun` / `destructive`; unknown flags (including `--dry-run` on non-destructive commands) are refused with `error: "unknown_flag"` so older silent-drop behavior cannot execute a mutation.

## Sub-features

- Root tree: `creek --help --json` → `{ ok: true, path: [], command.name: "creek", command.destructive: false, command.subcommands: [...] }`.
- Leaf schema: `creek doctor --help --json` (`destructive: false`); `creek deploy --help --json` (`destructive: true`, `dryRun: true`).
- Nested path: `creek env set --help --json` resolves `path: ["env","set"]` (not required for the default drive).
- Unknown flag: `creek doctor --dry-run --json` → exit 1, `ok: false`, `error: "unknown_flag"`, `flags: ["--dry-run"]`.

## How to get to it (user POV)

From any directory, after the CLI is installed or built:

```bash
creek --help --json
creek doctor --help --json
creek deploy --help --json
```

No project files, login, or network. Users and agents discover flags here; `destructive: true` means `--dry-run` exists.

## Driving it with drive.sh

```bash
.cursor/skills/verify-creek/scripts/drive.sh help-schema
```

Runs four captured invocations against `node packages/cli/dist/index.js` in `/tmp/creek-verify-$RUN_ID/projects/help-schema`:

1. `--help --json` — assert `ok`, `command.name=="creek"`, `command.destructive==false`.
2. `doctor --help --json` — assert `command.dryRun==false`.
3. `deploy --help --json` — assert `command.destructive==true`.
4. `doctor --dry-run --json` — assert exit 1, `error=="unknown_flag"`.

Evidence: `artifacts/$RUN_ID/drive/01-root-help/` … `04-doctor-unknown-dry-run/` plus `drive/summary.json`.

## Gotchas

- `jsonOutput` pretty-prints; parse the whole stdout object (not NDJSON).
- Human `--help` without `--json` on a TTY is citty usage text — do not scrape it.
- Do not “fix” `unknown_flag` by dropping `--dry-run` and re-running a mutating command.
- `--help --json` on an unknown subcommand returns `ok: false`, `error: "unknown_command"`.
