# API key scopes

A scoped API key can do only what its scopes allow, only in the team it is pinned to, and never more than its owner's current team role. It cannot call Better Auth's own endpoints except to read its session. A legacy key (no scopes stored) keeps its owner's full access.

## Sub-features

- `scoped-whoami` reads the session with a scoped key (`creek login --token`, `creek whoami`).
- `scoped-allowed` runs a command the key's scopes cover (`creek projects`, `creek env ls`).
- `scoped-refused` refuses a command outside the key's scopes (`creek env set`) without changing anything.
- `legacy-unchanged` runs the same refused command with a legacy key.
- `platform-admin-refused` refuses `creek ops deployments` to a platform admin's scoped key.
- `http-probe` checks the rules over raw HTTP: auth endpoints, path and header tricks, team pinning, deploy scope by branch, and a preview deploy that would add a binding or a queue to the project.

## How to get to it (user POV)

- Run any `creek` command after `creek login --token <KEY>` or with `CREEK_TOKEN`.
- Call the control-plane API with `x-api-key: <KEY>` (agents, CI, the MCP server).
- Scoped keys are minted server-side. Until the key-management route ships, `control-plane.sh key` stores the scopes the way that route will.

## Driving it with verify-creek

Preconditions:

- `bun`, `sqlite3`, `curl` and `python3` are on `PATH`.
- Launch as usual, then start a local control-plane: `LOCAL_ENV=$(.cursor/skills/verify-creek/scripts/control-plane.sh start "$RUN_ENV")`. Drive signed-in commands with `$LOCAL_ENV`, never `$RUN_ENV`.
- Seed one owner with a second team and a project:
  - `control-plane.sh signup "$RUN_ENV" owner@example.com` prints `userId`, `orgId`, `orgSlug`.
  - `control-plane.sh sql "$RUN_ENV" "INSERT INTO organization (id,name,slug,createdAt) VALUES ('org-b','B','team-b',0); INSERT INTO member (id,userId,organizationId,role,createdAt) VALUES ('m-b','<userId>','org-b','owner',4102444800); INSERT INTO project (id,slug,organizationId,createdAt,updatedAt) VALUES ('proj-site','site','<orgId>',0,0)"`. The late `member.createdAt` keeps the sign-up team first, so legacy keys still resolve to it.
  - `creek.sh "$RUN_ENV" -- init site --yes --json` writes `creek.toml` for `site` in the work directory (no network); `creek env` reads the project from it.
- Mint keys pinned to the sign-up team: `control-plane.sh key "$RUN_ENV" owner@example.com project:read,env:read <orgSlug>` (read), `... env:write <orgSlug>`, `... deploy:preview <orgSlug>`, `... legacy`.

- **Scoped whoami.** `creek.sh "$LOCAL_ENV" --evidence .cursor/skills/verify-creek/artifacts/api-key-scopes/<run>/login -- login --token <read key> --json` exits `0` with `ok: true`. Then `-- whoami --json` exits `0` with `email: "owner@example.com"`.
- **Scoped allowed.** `-- projects --json` exits `0` and lists `site`. `-- env ls --json` exits `0`.
- **Scoped refused.** `-- env set PROBE 1 --json` exits `1`; stderr or the JSON message names `env:write`. `control-plane.sh sql "$RUN_ENV" "SELECT count(*) n FROM environment_variable"` is unchanged.
- **Legacy unchanged.** `login --token <legacy key>`, then the same `env set` exits `0`.
- **Platform admin refused.** `control-plane.sh sql "$RUN_ENV" "UPDATE user SET role='admin'"`, log in with a scoped key that holds every scope, run `-- ops deployments --json`: exit `1`, `error: "forbidden"`. With the legacy key: exit `0`, `ok: true`.
- **HTTP probe.** Write `{"read","envwrite","preview","legacy","project":"site","otherTeam":"team-b"}` to a JSON file and run `.cursor/skills/verify-creek/scripts/api-key-probe.py <url from local.env> <file> $VERIFY_CREEK_RUN/control-plane/data/creek.db | tee <evidence>/probe.ndjson`. The last line is `{"summary": true, ..., "failed": 0}` and the exit code is `0`.
- **Proof.** Keep the evidence directories and `probe.ndjson`. Stop with `control-plane.sh stop "$RUN_ENV"` (`cleanup.sh` also stops it).

## Gotchas

- `$LOCAL_ENV` points the CLI at a real (local) server: `login --token` writes `$HOME/.creek/config.json` under the isolated HOME. That is expected here and not in the dead-API recipes.
- `control-plane.sh key` without a team slug pins to the user's earliest membership by `member.createdAt`. Seed extra teams with a later `createdAt`, or pass the slug.
- `serve.ts` applies migrations itself and swallows a failing one; if routes 500, read `control-plane/server.log` in the run directory.
- Better Auth stores `expiresAt` in seconds. Expiring a key by hand with milliseconds leaves it valid.
- `curl` normalizes `..` and `//` unless given `--path-as-is`; the probe uses raw HTTP so path variants reach the server as written.
- The probe writes env vars and a deployment through the allowed keys. Run it on a disposable run directory only.
