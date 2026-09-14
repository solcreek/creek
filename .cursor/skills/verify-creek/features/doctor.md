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

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports a clean isolated home.
- For `doctor-ok`, `$VERIFY_CREEK_WORK` contains an `index.html` (write one if needed).
- Do not pass `--last` on this isolated run; it needs a token and a live API.

- **Static payload.** Analyze the work directory. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/doctor/ok -- doctor --json`. Exit code `0`. stdout JSON has `ok: true` and `cwd` equal to `$VERIFY_CREEK_WORK`.
- **Findings shape.** Same payload: `summary` has numeric `error`, `warn`, and `info`. `findings` is an array. Each finding that is present has a `code` starting with `CK-`.
- **Explicit path.** Analyze the same tree by argument. Run `creek.sh "$RUN_ENV" --cwd "$VERIFY_CREEK_WORK" --evidence .cursor/skills/verify-creek/artifacts/doctor/path -- doctor "$VERIFY_CREEK_WORK" --json`. Exit code `0`. `cwd` is the explicit path.
- **`--last` unreachable.** Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/doctor/last -- doctor --last --json`. This path requires a session against a live API. With `CREEK_TOKEN` unset and `CREEK_API_URL=http://127.0.0.1:1` it must not be reported as verified. Record the exit code and JSON error as `verified-unreachable` (auth + live API).
- **Proof.** Keep the `ok` and `path` evidence directories. `$HOME/.creek/config.json` is still absent.

## Gotchas

- This feature's `creek doctor` is the product command. It is not `scripts/doctor.sh` (that script health-checks the isolated CLI).
- `ok: false` with error-severity findings exits 1. That is a valid project diagnosis, not a harness failure — assert the `CK-*` codes.
- `--last` talks to the control plane. Success against the dead URL would mean the flag is not actually fetching; failure is the expected isolated-run result.
- `stderr` may print a one-line human summary when stderr is a TTY. In this harness stderr is not a TTY; stdout is pure JSON.
