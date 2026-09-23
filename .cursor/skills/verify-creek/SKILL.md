---
name: verify-creek
description: "Drive the Creek CLI (creek / ck / crk) the way a user does: isolated HOME, JSON output, deploy dry-run, init, doctor, whoami, and help. Use when proving CLI behavior, checking a deploy-plan or init change, or verifying doctor/whoami output."
---

# Verify Creek

Creek's user-facing product is the `creek` CLI (`ck` and `crk` are the same binary). This skill drives that binary from a disposable `HOME` and project directory.

Other surfaces in this repo — `apps/dashboard` (Vite on port 3000), `apps/www` (Next.js), the control-plane HTTP API, and `mcp.creek.dev` — are out of scope here. Do not start them for a CLI proof.

Unit tests under `packages/cli/src/**/*.test.ts` import `command.run()` and mock config. They are not a user path. Drive `node packages/creek/bin.js`.

Feature recipes live in [features/](features/README.md). Read the index, then the matching feature file. A proof that uses one convenient entry point is incomplete when the map lists others.

## Launch

There is no long-lived server. Launch means: build the workspace CLI once, then create an isolated run directory.

From the repo root:

```bash
RUN_ENV=$(.cursor/skills/verify-creek/scripts/launch.sh)
```

Ready when `launch.sh` prints `run.env` on stdout (and `packages/cli/dist/index.js` exists). `VERIFY_CREEK_FORCE_BUILD=1` rebuilds even if dist is present. If the CLI build fails with `Failed to import module "unrun"`, tsdown 0.22.3 needs that peer at the repo root (`pnpm add -D unrun`); a present dist is enough and launch will not rebuild.

Each helper invocation after that sources `$RUN_ENV`, which:

- Sets `HOME` to `$VERIFY_CREEK_RUN/home` so `~/.creek/config.json` is not the user's.
- Unsets `CREEK_TOKEN` in `load_run_env`, and `run.env` unsets it again. An empty caller value is removed too, so it cannot stay set during a drive. With the variable gone, the CLI reads `~/.creek/config.json` from the isolated `HOME`, which this run leaves absent. Outside these helpers, `CREEK_TOKEN=""` is a different case: `getToken()` keeps that empty string, skips the config file, and `whoami` exits `not_authenticated` without calling the API.
- Points `CREEK_API_URL` and `CREEK_SANDBOX_API_URL` at `http://127.0.0.1:1` (connection refused). Commands that claim they make no network calls must succeed against that URL.
- Uses project cwd `$VERIFY_CREEK_WORK` unless a recipe passes `--cwd`.

Two runs can coexist: each `launch.sh` creates its own `verify-creek-*` directory. Never drive a `creek` process whose `HOME` is the login home.

Teardown: [Cleanup](#cleanup).

## Doctor

Run this first, and again whenever a drive looks off.

```bash
.cursor/skills/verify-creek/scripts/doctor.sh "$RUN_ENV"
```

Pass means: workspace facade binary exists, `creek --help --json` reports the version in `packages/creek/package.json`, `deploy`/`init`/`doctor`/`whoami`/`login` are present, `HOME` is the run home, `CREEK_TOKEN` is unset, API URLs are the dead local URL, and `$HOME/.creek/config.json` does not exist.

Fail means this instance is not worth driving. Do not fall back to the user's `creek` on `PATH` or to `~/.creek`.

## Drive

```bash
.cursor/skills/verify-creek/scripts/creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/<feature>/<run-id> -- <args>
```

Always pass `--json` on commands that accept it. Non-TTY already auto-enables JSON; the flag is the user-visible contract.

Stable handles (JSON keys and flags from this repo, not prompt text):

| User action | Command | Observable |
|---|---|---|
| Discover commands | `creek --help --json` | `ok: true`, `command.name` is `creek`, `command.subcommands[].name` includes `deploy` |
| Version | `creek --help --json` | `command.version` equals `packages/creek/package.json` `version` |
| Init a project | `creek init <name> --yes --json` | `ok: true`, `path` ends in `creek.toml`, file exists on disk |
| Init with database | `creek init <name> --db --yes --json` | `database: true`, `worker/index.ts` exists, `workerDependencies` is `["hono","creek","d1-schema"]` |
| Pre-deploy check | `creek doctor --json` | `ok`, `cwd`, `findings[].code` (`CK-*`) |
| Preview a deploy | `creek deploy --dry-run --json` | `mode: "dry-run"`, `wouldDeploy`, `target.type`, `sideEffects.networkCalls === false` |
| Auth state | `creek whoami --json` | unauthenticated: exit 1, `error: "not_authenticated"` |
| Agent login refusal | `creek login --json` | exit 1, `error: "interactive_login_unsupported"` |

Bare `creek deploy` (no `--sandbox`/`--prod`/`--yes`/`--dry-run`) in this non-TTY harness exits 1 with `error: "confirmation_required"`. That is the agent safety gate, not a hang.

`--dry-run` is only valid on commands that declare it (`deploy` does). On `status` it is an unknown flag and must not execute.

Do not call `creek login` without `--token` from a TTY in this harness: it opens a browser and writes the real config dir if `HOME` leaked.

## Evidence

Write proof under `.cursor/skills/verify-creek/artifacts/<feature>/<run-id>/`. `creek.sh --evidence` stores `stdout`, `stderr`, `exit`, `argv`, and `env.txt`. Copy any files the command wrote (`creek.toml`, `.gitignore`, `worker/index.ts`) into the same directory.

Proof standards:

- Exercise the real CLI entry (`packages/creek/bin.js`), not `command.run()` and not a mocked `CreekClient`.
- Capture the invocation and the resulting state: JSON body, exit code, and files on disk. A final JSON blob without the file is not enough for `init`.
- For `--dry-run`, do not trust the name or `sideEffects.networkCalls`. Observe: the command exits 0 against `http://127.0.0.1:1`, `$HOME/.creek/config.json` is still absent, and the work directory has no new network artifacts. Some dry-runs still touch the network; this one must not.
- `creek deploy --sandbox` hits the public sandbox API. It is not covered by the default map and must not be used to "just see if deploy works" during a CLI proof.
- Do not mock the sandbox or control-plane unless the feature under test is already isolated behind `--dry-run` or an unauthenticated local branch.

## Cleanup

```bash
.cursor/skills/verify-creek/scripts/cleanup.sh "$RUN_ENV"
```

Deletes only `$VERIFY_CREEK_RUN` (must match `*/verify-creek-*`). Does not kill by process name. Does not delete `.cursor/skills/verify-creek/artifacts/`.

If a drive started `creek dev` (port 3000 by default, collides with the dashboard), kill that child by the PID you started, then run `cleanup.sh`. Default recipes do not start `creek dev`.

After cleanup, confirm the evidence directory still exists.

## Helpers

All scripts are executable. `common.sh` is sourced by the others, not invoked.

```bash
RUN_ENV=$(.cursor/skills/verify-creek/scripts/launch.sh)
.cursor/skills/verify-creek/scripts/doctor.sh "$RUN_ENV"
.cursor/skills/verify-creek/scripts/creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/deploy-dry-run/proof -- deploy --dry-run --json
.cursor/skills/verify-creek/scripts/cleanup.sh "$RUN_ENV"
```

`creek.sh` extra flags, before `--`: `--cwd DIR` (default `$VERIFY_CREEK_WORK`), `--evidence DIR`.
