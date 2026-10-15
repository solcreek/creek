# API key scopes

A scoped API key can do only what its scopes allow, only in the team it is pinned to, and never more than its owner's current team role. It cannot call Better Auth's own endpoints except to read its session. A legacy key (no scopes stored) keeps its owner's full access.

## Sub-features

- `scoped-whoami` reads the session with a scoped key (`creek login --token`, `creek whoami`).
- `scoped-allowed` runs a command the key's scopes cover (`creek projects`, `creek env ls`).
- `scoped-refused` refuses a command outside the key's scopes (`creek env set`) without changing anything.
- `legacy-unchanged` runs the same refused command with a legacy key.
- `platform-admin-refused` refuses `creek ops deployments` to a platform admin's scoped key.
- `http-probe` checks the rules over raw HTTP: auth endpoints, path and header tricks, team pinning, deploy scope by branch, a preview deploy that would add a binding or a queue to the project, and key management (a key reads and revokes itself; it cannot mint, list or revoke other keys).
- `key-management` mints a key with a dashboard session (`POST /api-keys`), lists keys without secrets (`GET /api-keys`), reads a key from itself (`GET /api-keys/self`), and revokes it (`DELETE /api-keys/:id` with the session, `DELETE /api-keys/self` with the key).
- `scope-catalog` reads `GET /api-keys/scopes` with a session and with a narrow scoped key, and revalidates it by ETag.

## How to get to it (user POV)

- Run any `creek` command after `creek login --token <KEY>` or with `CREEK_TOKEN`.
- Call the control-plane API with `x-api-key: <KEY>` (agents, CI, the MCP server).
- A signed-in user mints scoped keys with `POST /api-keys` (session cookie only; API keys are refused): `{"name", "team": <id or slug>, "scopes": [..] | "<preset>", "expiresIn": <seconds, default 90 days, max 365>}`. The response carries the key once.
- An agent inspects its own key with `GET /api-keys/self` (scopes, team, the owner's role, effective scopes, expiry; a legacy key reports `legacy: true`, `access: "full"` and a sunset warning) and drops it with `DELETE /api-keys/self`.
- Anyone signed in (a session or any key, whatever its scopes) reads the scope catalog with `GET /api-keys/scopes`: every scope with its `description`, `risk` (`read` / `write` / `destructive` / `admin`), `impact` (`low` / `moderate` / `high`) and `minRole` (the least team role that may grant it), and every preset with its concrete `scopes` and `minRole`. It carries an `ETag` and `Cache-Control: private, max-age=300`; `If-None-Match` with that ETag answers `304`.
- `control-plane.sh key` mints through `POST /api-keys` (scoped, or a preset name) or Better Auth's `/api/auth/api-key/create` (`legacy`).

## Driving it with verify-creek

Preconditions:

- `bun`, `sqlite3`, `curl` and `python3` are on `PATH`.
- Launch as usual, then start a local control-plane: `LOCAL_ENV=$(.cursor/skills/verify-creek/scripts/control-plane.sh start "$RUN_ENV")`. Drive signed-in commands with `$LOCAL_ENV`, never `$RUN_ENV`.
- Seed one owner with a second team and a project:
  - `control-plane.sh signup "$RUN_ENV" owner@example.com` prints `userId`, `orgId`, `orgSlug`.
  - `control-plane.sh sql "$RUN_ENV" "INSERT INTO organization (id,name,slug,createdAt) VALUES ('org-b','B','team-b',0); INSERT INTO member (id,userId,organizationId,role,createdAt) VALUES ('m-b','<userId>','org-b','owner',4102444800); INSERT INTO project (id,slug,organizationId,createdAt,updatedAt) VALUES ('proj-site','site','<orgId>',0,0)"`. The late `member.createdAt` keeps the sign-up team first, so legacy keys still resolve to it.
  - `creek.sh "$RUN_ENV" -- init site --yes --json` writes `creek.toml` for `site` in the work directory (no network); `creek env` reads the project from it.
- Mint keys pinned to the sign-up team: `control-plane.sh key "$RUN_ENV" owner@example.com project:read,env:read <orgSlug>` (read), `... env:write <orgSlug>`, `... deploy:preview <orgSlug>`, `... read-only <orgSlug>` (a preset; the probe's `drop` key), `... legacy`.

- **Scoped whoami.** `creek.sh "$LOCAL_ENV" --evidence .cursor/skills/verify-creek/artifacts/api-key-scopes/<run>/login -- login --token <read key> --json` exits `0` with `ok: true`. Then `-- whoami --json` exits `0` with `email: "owner@example.com"`.
- **Scoped allowed.** `-- projects --json` exits `0` and lists `site`. `-- env ls --json` exits `0`.
- **Scoped refused.** `-- env set PROBE 1 --json` exits `1` with `error: "set_failed"`, `status: 403`, `apiError: "insufficient_scope"`, `details.required: ["env:write"]` and `details.granted` listing the key's scopes. `control-plane.sh sql "$RUN_ENV" "SELECT count(*) n FROM environment_variable"` is unchanged.
- **Legacy unchanged.** `login --token <legacy key>`, then the same `env set` exits `0`.
- **Platform admin refused.** `control-plane.sh sql "$RUN_ENV" "UPDATE user SET role='admin'"`, log in with a scoped key that holds every scope, run `-- ops deployments --json`: exit `1`, `error: "forbidden"`. With the legacy key: exit `0`, `ok: true`.
- **Key management.** With `-b $VERIFY_CREEK_RUN/control-plane/cookies-owner@example.com -H "origin: <url>"`: `POST /api-keys` with `{"name":"agent","team":"<orgSlug>","scopes":"agent-preview"}` answers `201` with `key`, `scopes` (the preset expanded), `expiresAt` 90 days out and `Cache-Control: no-store`. `expiresIn: 40000000` answers `400 invalid_expiry`; `scopes: ["project:admin"]` answers `400 unknown_scope`; a `permissions` field answers `400 unknown_field`; the same request with `x-api-key` answers `403 api_key_not_allowed`; with `origin: https://evil.example` it answers `403 forbidden`. The new key: `GET /projects` `200`, `POST /projects/site/env` `403 insufficient_scope`, `x-creek-team: team-b` `403 team_mismatch`, `GET /api-keys/self` `200` with `effectiveScopes`. `GET /api-keys` (session) lists keys with no `key` field and no secret. `DELETE /api-keys/<id>` (session) answers `{"revoked":true}`, after which the key gets `401`. `control-plane.sh sql "$RUN_ENV" "SELECT action FROM audit_log WHERE action LIKE 'api_key.%'"` shows each create and revoke.
- **Scope catalog.** `GET /api-keys/scopes` with the session cookie answers `200` with 17 `scopes` (each with `description`, `risk`, `impact`, `minRole`) and 4 `presets`; `full` has `minRole: "owner"`. With `x-api-key: <a key holding only logs:read>` it answers the same body; with `If-None-Match: <the ETag>` it answers `304` with an empty body. With no credentials it answers `401`.
- **HTTP probe.** Write `{"read","envwrite","preview","legacy","drop","project":"site","otherTeam":"team-b"}` to a JSON file and run `.cursor/skills/verify-creek/scripts/api-key-probe.py <url from local.env> <file> $VERIFY_CREEK_RUN/control-plane/data/creek.db | tee <evidence>/probe.ndjson`. The last line is `{"summary": true, ..., "failed": 0}` and the exit code is `0`.
- **Proof.** Keep the evidence directories and `probe.ndjson`. Stop with `control-plane.sh stop "$RUN_ENV"` (`cleanup.sh` also stops it).

## Gotchas

- `$LOCAL_ENV` points the CLI at a real (local) server: `login --token` writes `$HOME/.creek/config.json` under the isolated HOME. That is expected here and not in the dead-API recipes.
- `control-plane.sh key` without a team slug pins to the user's earliest membership by `member.createdAt`. Seed extra teams with a later `createdAt`, or pass the slug.
- Every `control-plane.sh start` writes a new `BETTER_AUTH_SECRET`, so session cookies from an earlier start are refused (`key` fails with `401`). After a restart, sign up a new user.
- `POST /api-keys` refuses scopes the creator's role in that team does not grant (`403 scope_exceeds_role`, listing them); a member cannot mint `full`.
- `serve.ts` applies migrations itself and swallows a failing one; if routes 500, read `control-plane/server.log` in the run directory.
- Better Auth stores `expiresAt` in seconds. Expiring a key by hand with milliseconds leaves it valid.
- `curl` normalizes `..` and `//` unless given `--path-as-is`; the probe uses raw HTTP so path variants reach the server as written.
- The probe writes env vars and a deployment through the allowed keys. Run it on a disposable run directory only.
