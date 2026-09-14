# Auth status

Whoami reports whether the CLI has a Creek session. Login in a non-interactive environment requires `--token` and otherwise refuses instead of opening a browser.

## Sub-features

- `whoami-signed-out` reports `not_authenticated` when no token is present.
- `login-noninteractive` refuses browser and headless prompts with `interactive_login_unsupported`.
- `whoami-signed-in` fetches the session from the API and is unreachable in this isolated run.

## How to get to it (user POV)

- Run `creek whoami`.
- Run `creek login` in a terminal (opens a browser).
- Run `creek login --token <KEY>` for CI and agents.
- Run `creek login --headless` to paste a key (TTY only).

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports `CREEK_TOKEN` unset and API URLs `http://127.0.0.1:1`.
- `$HOME/.creek/config.json` does not exist.

- **Signed out.** Ask who is logged in. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/whoami/signed-out -- whoami --json`. Exit code `1`. stdout JSON has `ok: false`, `authenticated: false`, `error: "not_authenticated"`. `breadcrumbs` include `creek login --token <KEY> --json`.
- **Login refusal.** Attempt interactive login. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/whoami/login-refused -- login --json`. Exit code `1`. stdout JSON has `ok: false` and `error: "interactive_login_unsupported"`. No browser process was started by this command. `$HOME/.creek/config.json` is still absent.
- **Signed-in unreachable.** `creek whoami --json` with a valid `CREEK_TOKEN` against a live API is the signed-in path. Do not set a token in this harness. Record the path as `verified-unreachable` (auth + live API).
- **Proof.** Keep both evidence directories. Confirm `$HOME/.creek/config.json` is absent after `login --json`.

## Gotchas

- An empty `CREEK_TOKEN=""` is treated as a token and will attempt `getSession()` against the API. The harness unsets the variable; do not export an empty value.
- `creek login` on a TTY calls `open`/`xdg-open`. Only the non-TTY refusal is safe to drive here.
- Do not pass `--token` with a real key during verification: it writes `$HOME/.creek/config.json` and would call the live API if URLs were not dead.
- Success of `whoami` against `http://127.0.0.1:1` would mean it did not actually check a session. Unsigned-out must fail locally before any fetch.
