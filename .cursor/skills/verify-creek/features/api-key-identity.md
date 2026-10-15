# API key identity

The CLI says which API key it is using, where the key comes from (`CREEK_TOKEN` or the key `creek login` saved), and what the key may do. It warns when `CREEK_TOKEN` overrides a login, logs out with or without revoking the key, and refuses key management that needs a dashboard session.

## Sub-features

- `whoami-scoped` reports a saved scoped key: `tokenSource: "config"`, `key.kind: "scoped"`, team, scopes, effective scopes, expiry, last use.
- `whoami-legacy-env` reports a legacy key from `CREEK_TOKEN` (`kind: "legacy"`, `access: "full"`) and warns that it overrides the saved key.
- `whoami-empty-env` reports that an empty `CREEK_TOKEN` hides the saved key.
- `login-with-env` saves the key but warns (JSON `warning`, human `WARN` line) that `CREEK_TOKEN` keeps winning.
- `keys-session-only` refuses `creek keys ls` / `keys create` with `session_required` and no request.
- `logout-plain` forgets the saved key; the key stays valid on the server.
- `logout-revoke` revokes the active key (with CREEK_TOKEN and a different saved key: `ambiguous_credentials`, nothing sent), after which the key gets `401`; a second `--revoke` reports `already_invalid` and still clears local state.
- `keys-revoke-self` revokes the key in use (`--dry-run` first).

## How to get to it (user POV)

- `creek whoami`, `creek login --token <KEY>`, `creek logout [--revoke]`, `creek keys self|ls|create|revoke --self`.
- Any of them with `CREEK_TOKEN` set (`creek.sh --creek-token <VALUE>` sets it for one drive; the value may be empty).

## Driving it with verify-creek

Preconditions:

- Launch, rebuild the CLI if it changed (`VERIFY_CREEK_FORCE_BUILD=1`), and start a local control-plane as in [API key scopes](api-key-scopes.md). Drive with `$LOCAL_ENV`.
- `control-plane.sh signup "$RUN_ENV" owner@example.com`, then mint `SCOPED` (`... key "$RUN_ENV" owner@example.com project:read,env:read <orgSlug>`), `LEGACY` (`... legacy`) and `OTHER` (`... read-only <orgSlug>`).

- **Scoped whoami.** `-- login --token $SCOPED --json`, then `-- whoami --json`: exit `0`, `tokenSource: "config"`, `key.kind: "scoped"`, `key.team.slug` is the org slug, `key.effectiveScopes` `["project:read","env:read"]`, `key.expiresAt` 90 days out.
- **Legacy whoami via CREEK_TOKEN.** `--creek-token $LEGACY -- whoami --json`: exit `0`, `tokenSource: "env:CREEK_TOKEN"`, `key.kind: "legacy"`, `key.scopes: null`, `key.warning` (legacy sunset), and a top-level `warning` that CREEK_TOKEN overrides the saved key.
- **Login with CREEK_TOKEN set.** `--creek-token $LEGACY -- login --token $OTHER --json`: exit `0`, `saved: true`, `tokenSource: "env:CREEK_TOKEN"`, `warning`, first breadcrumb `unset CREEK_TOKEN`; `$HOME/.creek/config.json` holds `$OTHER`. On a pseudo-TTY (`script -q`), the same login prints `WARN  CREEK_TOKEN is set in this environment and will keep winning`.
- **Empty CREEK_TOKEN.** `--creek-token "" -- whoami --json`: exit `1`, `not_authenticated`, `tokenSource: "env:CREEK_TOKEN"`, `warning` names the empty variable.
- **Session-only commands.** `-- keys ls --json` and `-- keys create --name x --team <slug> --scopes read-only --json`: exit `1`, `error: "session_required"`, `dashboardUrl`, breadcrumb `creek keys self --json`.
- **Plain logout.** `-- logout --json`: exit `0`, `keyStillValid: true`, `keyPrefix`, `dashboardUrl` (revoking the forgotten key now needs the dashboard; no `--revoke` breadcrumb unless `CREEK_TOKEN` is set); `--creek-token $OTHER -- whoami --json` still exits `0`.
- **Logout --revoke.** `-- login --token $OTHER --json`, `-- logout --revoke --json`: `revoked: true`, `keyId`; `curl -H "x-api-key: $OTHER" <url>/projects` answers `401`; `--creek-token $OTHER -- whoami --json` exits `1` `session_expired`. Put `$OTHER` back in `config.json` and run `-- logout --revoke --json` again: exit `0`, `revoked: false`, `reason: "already_invalid"`, `configCleared: true`.
- **Keys revoke --self.** `--creek-token $LEGACY -- keys revoke --self --dry-run --json` (no change; `key` shown), then without `--dry-run`: `revoked: true`; whoami with it then exits `1`.
- **Proof.** `control-plane.sh sql "$RUN_ENV" "SELECT action, resourceId FROM audit_log WHERE action LIKE 'api_key.%'"` shows one `api_key.revoke` per revoked key. Keep the evidence directories.

## Gotchas

- The harness is non-TTY, so every drive prints JSON. Prove human lines on a pseudo-TTY (`script -q <file> node "$VERIFY_CREEK_BIN" …` after sourcing `$LOCAL_ENV`).
- `--creek-token` is the only way to set `CREEK_TOKEN` in a drive: `load_run_env` removes the caller's value.
- Revoked keys stay revoked; mint fresh keys for a re-run.
- Against the local control-plane the dashboard URL in `session_required` is the API URL (only `:8787` and `api.` hosts map to a dashboard).
