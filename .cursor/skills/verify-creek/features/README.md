# Creek CLI verification map

This directory is the maintained source for verifying user-facing Creek CLI behavior. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch via `.cursor/skills/verify-creek/scripts/launch.sh` so `HOME` is a disposable `verify-creek-*` directory and `CREEK_TOKEN` is unset.
- `CREEK_API_URL` and `CREEK_SANDBOX_API_URL` are `http://127.0.0.1:1`.
- Run `.cursor/skills/verify-creek/scripts/doctor.sh "$RUN_ENV"` and require the workspace facade version, dead API URLs, and no `$HOME/.creek/config.json`.
- Drive only through `.cursor/skills/verify-creek/scripts/creek.sh`.
- Never drive a `creek` whose `HOME` is the login home.

## Driving conventions

- Start every recipe from the launch baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep flags and JSON keys unchanged.
- Pass `--json` on every command that accepts it.
- Restore the work directory after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final JSON.
- CLI proof includes the command, stdout, stderr, and exit code under `.cursor/skills/verify-creek/artifacts/<feature>/`.
- Mutation proof includes a second read of the file on disk (`creek.toml`, `.gitignore`, `worker/index.ts`).
- Dry-run proof includes the dead-API observation: exit 0 while `CREEK_API_URL=http://127.0.0.1:1`.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-creek` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Discover commands](./help.md) covers `creek --help --json` schema and version identity.
- [Initialize a project](./init.md) covers writing `creek.toml`, `.gitignore`, and the `--db` worker scaffold.
- [Pre-deploy doctor](./doctor.md) covers analyzing a directory for `CK-*` findings.
- [Deploy dry-run](./deploy-dry-run.md) covers the no-network deploy plan, payload gates, and the non-TTY confirmation gate.
- [Auth status](./whoami.md) covers unauthenticated `whoami` and non-interactive `login` refusal.
