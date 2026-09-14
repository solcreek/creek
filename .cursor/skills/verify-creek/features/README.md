# Feature map

Index of Creek CLI features this skill can drive. Primary surface: `node packages/cli/dist/index.js` (user-facing `creek` via `packages/creek`). Secondary (`apps/dashboard`, `packages/mcp-server`, `apps/www`) are out of scope unless CLI is blocked.

Keep this map current with `/maintain-verification-skill`.

## Index

| Id | User command | Auth | `--dry-run` in schema | Default proof |
| --- | --- | --- | --- | --- |
| [help-schema](help-schema.md) | `creek --help --json`, subcommand help, unknown-flag refusal | no | n/a | yes |
| [init](init.md) | `creek init --json --yes` | no | no (still writes `creek.toml` in cwd) | yes |
| [doctor](doctor.md) | `creek doctor --json` | no (`--last` needs auth — skip) | no | yes |
| [deploy-dry-run](deploy-dry-run.md) | `creek deploy --dry-run --json` | no | yes (`destructive: true` = preview exists; still observe hashes) | yes |
| [whoami](whoami.md) | `creek whoami --json` | default unauthenticated; opt-in `VERIFY_CREEK_ALLOW_AUTH=1` + `VERIFY_CREEK_TOKEN` | no | yes (isolated HOME; parent Creek auth env stripped) |

`destructive: true` means the command **declares `--dry-run`**, not “safe to mutate”. Mutators without that flag include `creek projects delete`, `creek init`, and `creek login --token`. Do not run those from this skill unless a feature file says so.

Do not add `creek deploy --sandbox` / `--prod` as a default mapped drive. Sandbox still publishes a public URL; production mutates a live slot. Authenticated whoami is opt-in only (`VERIFY_CREEK_TOKEN`, never parent `CREEK_TOKEN`).

## Baseline preconditions

- Launch completed: `packages/cli/dist/index.js` exists; `node packages/cli/dist/index.js --help --json` exits 0.
- Environment doctor (`scripts/doctor.sh`) exited 0.
- `RUN_ID` set (or helpers generate a **new** one — they never load committed `artifacts/LAST_RUN_ID`). Scratch is `/tmp/creek-verify-$RUN_ID`, not the monorepo and not `$HOME/.creek`.
- `HOME` for Creek processes is `$SCRATCH/home`. Parent Creek auth env (`CREEK_TOKEN`, `CREEKD_TOKEN`, `CREEKCTL_TOKEN`, `VERIFY_CREEK_TOKEN`) is unset in the child. `python3` is on PATH.
- Node `^22.18.0 || >=24.11.0` (not 23.x, not 24.0–24.10), `pnpm@10.6.5` (or `corepack pnpm`).

## Driving conventions

- Invoke `scripts/drive.sh <id>` — do not paste vitest files into the harness.
- Raw `scripts/drive.sh --raw --cwd ...` stays inside `$SCRATCH/projects`; never point it at the repo or another arbitrary writable path.
- Always pass `--json` unless proving human output (not required for the starter set).
- Consult `creek <cmd> --help --json` before `--dry-run`. `destructive: true` iff `--dry-run` is declared (preview support). `creek doctor --dry-run` is `unknown_flag`. `creek projects delete` mutates with `destructive: false` — do not drive it here.
- Non-interactive `creek deploy` without `--dry-run` / `--sandbox` / `--prod` / `--yes` exits with `confirmation_required`. Do not treat that as a successful deploy proof.
- `--yes` is not implied by `--json`.
- One disposable project dir per drive. Do not reuse another run's scratch.
- Capture argv (redacted), stdout, stderr, exit code, and cwd/HOME **hash** deltas (`filesModified` counts in-place writes).
- If you need Cleanup to terminate a helper process, write its PID record with `record_pid <safe-basename> <pid>` so PID reuse cannot target another process. PID record names are a single `[A-Za-z0-9._-]+` segment. Tmux session names must include `$RUN_ID`.

## Proof standards

A drive is proven when:

1. Evidence is under `.cursor/skills/verify-creek/artifacts/$RUN_ID/drive/` (not only the terminal).
2. JSON stdout parses; asserted fields match the feature file.
3. Side effects were **observed** via content hashes (added/removed/**modified** paths under the project and isolated HOME), not assumed from flag names.
4. Cleanup deleted `/tmp/creek-verify-$RUN_ID` and **left artifacts in place**.
5. No production credentials were used; no shared live deployment was driven.

`unmet-precondition` (exit 2 from `drive.sh`) is a valid recorded outcome for auth-gated paths. It is not a pass for auth-free features.
