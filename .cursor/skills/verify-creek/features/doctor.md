# Pre-deploy doctor

Doctor analyzes a project directory for pre-deploy issues and reports stable `CK-*` finding codes. It does not deploy and does not require a Creek account.

## Sub-features

- `doctor-ok` returns `ok: true` for a directory with a deployable static payload.
- `doctor-findings` lists `findings[].code`, `severity`, and `summary` counts.
- `doctor-path` analyzes an explicit directory argument instead of cwd.
- `doctor-last` (`--last`) diagnoses the most recent failed deployment via the API and is unreachable without auth.

## How to get to it (user POV)

- Run `creek doctor` in a project directory.
- Run `creek doctor <path>` to analyze another directory.
- Run `creek doctor --last` to diagnose the latest failed deployment (signed-in).
- Run `creek doctor --last --project <slug>` when the directory has no project name in `creek.toml`.

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports a clean isolated home.
- For `doctor-ok`, `$VERIFY_CREEK_WORK` contains an `index.html` (write one if needed).
- `--last` success needs a token and a live API. The isolated drive below records the auth gate and stops there.

- **Static payload.** Analyze the work directory. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/doctor/ok -- doctor --json`. Exit code `0`. stdout JSON has `ok: true` and `cwd` equal to `realpath` of `$VERIFY_CREEK_WORK`. On macOS that is `/private` plus the `/var/folders/...` path `launch.sh` printed.
- **Findings shape.** Same payload: `summary` has numeric `error`, `warn`, and `info`. `findings` is an array. Each finding that is present has a `code` starting with `CK-`.
- **Explicit path.** Analyze the same tree by argument. Run `creek.sh "$RUN_ENV" --cwd "$VERIFY_CREEK_WORK" --evidence .cursor/skills/verify-creek/artifacts/doctor/path -- doctor "$VERIFY_CREEK_WORK" --json`. Exit code `0`. `cwd` is the argument string. That string is resolved, and it is left as given when it is already absolute, so it can differ from the implicit `cwd` above.
- **`--last` unreachable.** Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/doctor/last -- doctor --last --json`. Exit code `1`. stdout JSON has `ok: false`, `error: "not_authenticated"`, and no `findings`. That is the auth gate. Record the path as `verified-unreachable` (a token, then a live API). `$HOME/.creek/config.json` is still absent.
- **Proof.** Keep the `ok` and `path` evidence directories. `$HOME/.creek/config.json` is still absent.

## Gotchas

- This feature's `creek doctor` is the product command. It is not `scripts/doctor.sh` (that script health-checks the isolated CLI).
- `ok: false` with error-severity findings exits 1. That is a valid project diagnosis, not a harness failure — assert the `CK-*` codes.
- On macOS the implicit `cwd` is the real path of the work directory. Compare it with `realpath`, the same way deploy dry-run does. The explicit-path `cwd` stays the absolute string you passed.
- `--last` reaches the control plane after a token is present. With `CREEK_TOKEN` unset and no config file it exits `not_authenticated` and does not open a connection. A token against `http://127.0.0.1:1` is the fetch, and a success on that URL would mean the flag skipped the network. Diagnosing a failed deployment stays unreachable until there is a token and a live API.
- `stderr` may print a one-line human summary when stderr is a TTY. In this harness stderr is not a TTY; stdout is pure JSON.
