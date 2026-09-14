---
name: verify-creek
description: Prove real Creek CLI behavior (packages/cli → user-facing `creek` via packages/creek) by launching, doctoring, driving, and capturing evidence. Use when an agent must verify deploy, init, doctor, help-schema, or whoami against the built binary — not unit tests or MSW.
---

# verify-creek

Primary surface is the **Creek CLI**. Implementation lives in `packages/cli`; users invoke `creek` / `ck` / `crk` from the `creek` npm facade (`packages/creek/bin.js` re-exports `@solcreek/cli`). Commands are short-lived. There is no long-running server for these proofs.

Secondary surfaces — do not make them primary, do not add Playwright in this skill: `apps/dashboard`, `packages/mcp-server`, `apps/www` docs. Prefer CLI.

Existing vitest/MSW tests in `packages/cli` are **not** this harness. They may inform flags; they must not replace driving `packages/cli/dist/index.js`.

Helpers (executable) live next to this file. From the repo root:

```bash
export RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
.cursor/skills/verify-creek/scripts/launch.sh
.cursor/skills/verify-creek/scripts/doctor.sh
.cursor/skills/verify-creek/scripts/drive.sh help-schema   # or doctor | init | deploy-dry-run | whoami
.cursor/skills/verify-creek/scripts/cleanup.sh
test -d ".cursor/skills/verify-creek/artifacts/${RUN_ID}"
```

Feature map: `features/README.md`. Keep the map current via `/maintain-verification-skill`.

## Launch

Monorepo: `pnpm@10.6.5` + turbo. `tsdown` 0.22.3 requires Node `^22.18.0 || >=24.11.0`. CI uses Node 24:

```
pnpm --filter @solcreek/sdk --filter @solcreek/cli --filter @solcreek/runtime --filter create-creek-app --filter @solcreek/build-container build
```

On a cold agent (this workspace):

1. `pnpm install --frozen-lockfile` if `node_modules/` is missing (helpers fall back to `corepack pnpm` when `pnpm` is not already on `PATH`).
2. Put a Node that matches `^22.18.0 || >=24.11.0` first on `PATH` (reject 23.x and 24.0–24.10). nvm `v22.22.2` is installed on some pods; `/exec-daemon/node` may be 22.14.0 and will fail tsdown. `python3` is required for evidence JSON and file-hash snapshots.
3. Build the CLI workspace packages:

```bash
pnpm --filter @solcreek/sdk --filter @solcreek/cli build
```

Verified on Node v22.22.2: that filter pair writes `packages/cli/dist/index.js` and `node packages/cli/dist/index.js --help --json` exits 0. If it fails with `Failed to import module "unrun"` (tsdown auto config-loader on older Node; `unrun` is an optional peer this repo does not declare), use:

```bash
pnpm --filter @solcreek/sdk exec tsdown --config-loader native
pnpm --filter @solcreek/cli exec tsdown --config-loader native
```

`scripts/launch.sh` runs that sequence.

**Verified invoke** (must succeed before Doctor/Drive):

```bash
node packages/cli/dist/index.js --help --json
```

Expect exit 0, stdout JSON `{ "ok": true, "path": [], "command": { "name": "creek", ... } }`. The dist file is executable (`#!/usr/bin/env node`). Facade equivalent after the same build: `node packages/creek/bin.js --help --json`. Workspace root does **not** hoist a `creek` bin (`pnpm exec creek` is not found) because the root package does not depend on `creek`.

## Doctor

Environment health — not `creek doctor`. Fail closed.

```bash
.cursor/skills/verify-creek/scripts/doctor.sh
```

Checks: `node` + `pnpm` available (directly or via `corepack`), `packages/cli/dist/index.js` exists, `node packages/cli/dist/index.js --version` exits 0, `--help --json` parses, `command.name === "creek"`, subcommands include `init`, `deploy`, `doctor`, `whoami`, root `destructive === false`.

Report: `.cursor/skills/verify-creek/artifacts/$RUN_ID/doctor/report.json`. Missing dist → `unmet-precondition` (run Launch). Do not start Drive until this exits 0.

## Drive

Each drive uses `/tmp/creek-verify-$RUN_ID/...` (created by `ensure_run`). Helpers generate a fresh `RUN_ID` when unset; they do **not** reuse committed `artifacts/LAST_RUN_ID`. Export `RUN_ID` yourself to share one id across launch → doctor → drive → cleanup. A `RUN_ID` whose artifacts already contain `cleanup.json` is refused (protects the committed sample).

Every Creek invocation sets `HOME` to that scratch home and **unsets parent Creek auth env** (`CREEK_TOKEN`, `CREEKD_TOKEN`, `CREEKCTL_TOKEN`). Do not pass production credentials. Do not double-drive a shared live deployment. Do not run `creek deploy --sandbox` / `--prod` as a default proof.

Prefer `--json`. In `--help --json`, `destructive: true` means the command **declares `--dry-run`** (a preview flag exists). It is **not** “safe to mutate” and it is **not** an exhaustive list of mutators. Commands can mutate without `--dry-run` and still report `destructive: false` — including `creek projects delete`, `creek init`, and `creek login --token`. Use `--dry-run` only when the leaf schema has `dryRun: true`. Otherwise `--dry-run` is `unknown_flag` (exit 1); do not retry by dropping the flag, and do not execute the mutation unless a feature file says so.

```bash
.cursor/skills/verify-creek/scripts/drive.sh help-schema
.cursor/skills/verify-creek/scripts/drive.sh doctor
.cursor/skills/verify-creek/scripts/drive.sh init
.cursor/skills/verify-creek/scripts/drive.sh deploy-dry-run
.cursor/skills/verify-creek/scripts/drive.sh whoami
.cursor/skills/verify-creek/scripts/drive.sh --raw -- <creek-args...>
.cursor/skills/verify-creek/scripts/drive.sh --raw --cwd nested/raw-case -- <creek-args...>
```

Raw mode is still scratch-only: `--cwd` may select only a subdirectory under `$SCRATCH/projects`, never the repo or another arbitrary path.

Plain shell with captured stdout/stderr is enough (commands exit). PTY/tmux is optional; if you start a tmux session, record its name in `$SCRATCH/tmux-sessions` and write PID records with `record_pid <name> <pid>` so Cleanup can tear down **only** those exact processes.

Mapped features: `features/`. Drive at least one auth-free feature end-to-end after Doctor (`help-schema` or `doctor`).

## Evidence

Store under `.cursor/skills/verify-creek/artifacts/$RUN_ID/` — **Cleanup must not delete this tree**.

Per invocation (under `drive/<label>/`): `argv.json` (secret flags `--token` / `--creekd-token` / `--*-token` redacted, including `--flag=value`), `stdout`, `stderr`, `exit_code`, `meta.json`, hash snapshots (`tree-before.json` / `tree-after.json` / HOME equivalents) and `side-effects.json` (`filesAdded` / `filesRemoved` / `filesModified`, same for isolated HOME). JSON commands: parse stdout; record `ok` / error code / findings.

Also: `run.json`, `launch/`, `doctor/`, `drive/summary.json`, `cleanup.json`. `artifacts/LAST_RUN_ID` is a pointer written after a live helper run; it is not an input to launch/doctor/drive.

Observe dry-run by **both** declared JSON (`sideEffects.networkCalls/fileUploads/buildExecuted`) **and** hash snapshots (in-place writes count as `filesModified`). Do not assume dry-run skipped network.

## Cleanup

```bash
.cursor/skills/verify-creek/scripts/cleanup.sh "$RUN_ID"
# or, with RUN_ID still exported and scratch still live:
.cursor/skills/verify-creek/scripts/cleanup.sh
```

Removes `/tmp/creek-verify-$RUN_ID` only. SIGTERM only PIDs listed in that scratch `pids/` directory **when the PID file also matches the original `/proc` start time**. Kills only tmux sessions listed in that scratch `tmux-sessions` file. Writes `cleanup.json` into the artifacts dir. `LAST_RUN_ID` is used only when the matching scratch dir still exists — never to rewrite a finished sample. Then confirm `test -d .cursor/skills/verify-creek/artifacts/$RUN_ID`.

## Helpers

| Script | Invocation | Role |
| --- | --- | --- |
| `scripts/lib.sh` | sourced, not executed | `RUN_ID` validation, scratch, isolated HOME, raw `--cwd` guardrails, PID recording, hash snapshots, `capture_cmd` (`python3` required) |
| `scripts/launch.sh` | `.cursor/skills/verify-creek/scripts/launch.sh` | install (if needed), build CLI, prove `--help --json` |
| `scripts/doctor.sh` | `.cursor/skills/verify-creek/scripts/doctor.sh` | environment health |
| `scripts/drive.sh` | `.cursor/skills/verify-creek/scripts/drive.sh <feature>` | one mapped feature + evidence |
| `scripts/cleanup.sh` | `.cursor/skills/verify-creek/scripts/cleanup.sh` | scratch teardown; keep artifacts |

All Creek child processes: `env -u CREEK_TOKEN -u CREEKD_TOKEN -u CREEKCTL_TOKEN HOME=$SCRATCH/home node packages/cli/dist/index.js ...`. Authenticated whoami only: `VERIFY_CREEK_ALLOW_AUTH=1` plus `VERIFY_CREEK_TOKEN` (scoped non-production). Parent Creek auth env is never inherited.
