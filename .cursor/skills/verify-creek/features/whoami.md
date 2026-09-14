# whoami

`creek whoami --json` is the read-only identity check. With no token (parent Creek auth env stripped and no `~/.creek/config.json`) it exits 1 with `{ ok: false, authenticated: false, error: "not_authenticated" }`. Default drive proves that unauthenticated shape (parent `CREEK_TOKEN` / `CREEKD_TOKEN` / `CREEKCTL_TOKEN` are ignored). Opt-in auth uses `VERIFY_CREEK_ALLOW_AUTH=1` plus `VERIFY_CREEK_TOKEN` only.

## Sub-features

- Unauthenticated (default): isolated HOME, parent `CREEK_TOKEN` unset → exit 1, `error: "not_authenticated"`.
- Authenticated (opt-in): `VERIFY_CREEK_ALLOW_AUTH=1` **and** `VERIFY_CREEK_TOKEN=<scoped non-production token>`. The child receives only that token as `CREEK_TOKEN`. Assert exit 0, `authenticated: true`. Missing token → `unmet-precondition` (exit 2). Parent Creek auth env is never inherited.
- `creek login` without `--token` on a non-TTY is `interactive_login_unsupported` — do not run login from this skill.
- `whoami` does not declare `--dry-run` (`destructive: false`). `--dry-run` is `unknown_flag`. It is read-only against the API when a token is passed.

## How to get to it (user POV)

```bash
creek whoami --json
```

Users run this after `creek login`. Agents should treat `authenticated: false` as a skip for cloud mutations, not as a prompt to open a browser.

## Driving it with drive.sh

```bash
.cursor/skills/verify-creek/scripts/drive.sh whoami
# opt-in authenticated (non-production token only):
VERIFY_CREEK_ALLOW_AUTH=1 VERIFY_CREEK_TOKEN=... .cursor/skills/verify-creek/scripts/drive.sh whoami
```

Default: isolated HOME, ignore parent Creek auth env, assert unauthenticated JSON. Opt-in: pass **only** `VERIFY_CREEK_TOKEN` into the child and assert `authenticated: true`. Tokens must not appear in artifacts (`argv.json` redacts `--token`; env values are never written).

## Gotchas

- Do not write tokens into artifacts. Do not commit `~/.creek`.
- Parent Creek auth env is ignored unless you copy a scoped token into `VERIFY_CREEK_TOKEN` (don't reuse production credentials).
- Refuse to chain whoami → deploy against a shared production project.
