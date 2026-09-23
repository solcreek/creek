# Discover commands

Help lets a user list Creek subcommands and flags as JSON, including which commands declare `--dry-run`, without contacting the network.

## Sub-features

- `help-root` returns the root schema with every top-level subcommand.
- `help-version` reports the same version as the installed `creek` package.
- `help-deploy` marks `deploy` as `dryRun: true` / `destructive: true`.
- `help-unknown` rejects an unknown subcommand as structured JSON.

## How to get to it (user POV)

- Run `creek --help --json`.
- Run `creek deploy --help --json` for the deploy subtree.
- Run `creek nosuch --help --json` for an unknown command.

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports the workspace facade version and the dead API URL.
- Work directory is empty. Help does not read the project.

- **Root schema.** List commands. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/help/root -- --help --json`. Exit code `0`. stdout JSON has `ok: true`, `path: []`, `command.name` equal to `creek`, and `command.subcommands[].name` includes `deploy`, `init`, `doctor`, `whoami`, and `login`.
- **Version.** Same payload: `command.version` equals the `version` field in `packages/creek/package.json`.
- **Deploy subtree.** Inspect deploy flags. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/help/deploy -- deploy --help --json`. Exit code `0`. `command.name` is `deploy`, `command.dryRun` is `true`, `command.destructive` is `true`, and `command.args` is a list of objects whose `name` includes `dry-run`, `sandbox`, and `prod`.
- **Unknown command.** Ask for a missing command. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/help/unknown -- nosuch --help --json`. Exit code `1`. stdout JSON has `ok: false` and `error: "unknown_command"`.
- **Proof.** Keep the root, deploy, and unknown evidence directories. The version check is the root payload. `$HOME/.creek/config.json` is still absent.

## Gotchas

- `creek --version` prints human text through citty and is not the JSON identity check. Use `--help --json` for `command.version`.
- `--help --json` is intercepted before citty usage text. Assert JSON, not a usage banner.
- A missing subcommand in the schema is a product change, not a harness miss. Record the names actually returned.
