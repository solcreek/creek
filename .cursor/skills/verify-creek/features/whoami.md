# whoami

`creek whoami --json` is the read-only identity check. With no token (`CREEK_TOKEN` unset and no `~/.creek/config.json`) it exits 1 with `{ ok: false, authenticated: false, error: "not_authenticated" }`. With a valid token it calls `GET` session on the API and prints `user` / `email` / `api`. Default drive proves the unauthenticated shape without touching the developer’s session; an explicit opt-in auth proof may preserve only the provided env token while still isolating `HOME`.

## Sub-features

- Unauthenticated (default): isolated HOME, `CREEK_TOKEN` unset → exit 1, `error: "not_authenticated"`, breadcrumbs for `creek login --token <KEY> --json`.
- Authenticated (optional, not default): requires `VERIFY_CREEK_ALLOW_AUTH=1` and an explicit non-production token. Helpers preserve that env token only for the child process; they still do not read `~/.creek`.
- `creek login` without `--token` on a non-TTY is `interactive_login_unsupported` — do not run login from this skill.
- `whoami` is not destructive (`--dry-run` is `unknown_flag`).

## How to get to it (user POV)

```bash
creek whoami --json
```

Users run this after `creek login`. Agents should treat `authenticated: false` as a skip for cloud mutations, not as a prompt to open a browser.

## Driving it with drive.sh

```bash
.cursor/skills/verify-creek/scripts/drive.sh whoami
```

If `CREEK_TOKEN` is already set in the agent environment and `VERIFY_CREEK_ALLOW_AUTH` is not `1`, the script records `unmet-precondition` and exits 2 (does not send that token to api.creek.dev). Otherwise it runs `whoami --json` under isolated HOME and asserts the unauthenticated JSON by default; opt-in auth runs record `creekTokenInherited: true` in `meta.json` without writing the token itself.

## Gotchas

- Helpers normally unset `CREEK_TOKEN`. The extra guard exists so a parent environment token is not silently used.
- Do not write tokens into artifacts. Do not commit `~/.creek`.
- A live `whoami` with production credentials is still a network call to `api.creek.dev`; it is read-only but not the default proof.
- Refuse to chain whoami → deploy against a shared production project.
