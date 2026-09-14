# Feature map

Index of Creek CLI features this skill can drive. Primary surface: `node packages/cli/dist/index.js` (user-facing `creek` via `packages/creek`). Secondary (`apps/dashboard`, `packages/mcp-server`, `apps/www`) are out of scope unless CLI is blocked.

Keep this map current with `/maintain-verification-skill`.

## Index

| Id | User command | Auth | Destructive | Default proof |
| --- | --- | --- | --- | --- |
| [help-schema](help-schema.md) | `creek --help --json`, subcommand help, unknown-flag refusal | no | n/a | yes |
| [init](init.md) | `creek init --json --yes` | no | writes files in cwd only | yes |
| [doctor](doctor.md) | `creek doctor --json` | no (`--last` needs auth — skip) | no | yes |
| [deploy-dry-run](deploy-dry-run.md) | `creek deploy --dry-run --json` | no | `destructive: true` but dry-run must not upload | yes |
| [whoami](whoami.md) | `creek whoami --json` | read-only; default proves unauthenticated | no | yes (isolated HOME) |

Do not add `creek deploy --sandbox` / `--prod` as a default mapped drive. Sandbox still publishes a public URL; production mutates a live slot. If a later feature needs auth, document the precondition and emit `unmet-precondition` rather than using `~/.creek` or `CREEK_TOKEN` from the developer machine.

## Baseline preconditions

- Launch completed: `packages/cli/dist/index.js` exists; `node packages/cli/dist/index.js --help --json` exits 0.
- Environment doctor (`scripts/doctor.sh`) exited 0.
- `RUN_ID` set (or helpers generate one). Scratch is `/tmp/creek-verify-$RUN_ID`, not the monorepo and not `$HOME/.creek`.
- `HOME` for Creek processes is `$SCRATCH/home`. `CREEK_TOKEN` is unset.
- Node `^22.18.0 \|\| >=24.11.0`, `pnpm@10.6.5`.

## Driving conventions

- Invoke `scripts/drive.sh <id>` — do not paste vitest files into the harness.
- Always pass `--json` unless proving human output (not required for the starter set).
- Consult `creek <cmd> --help --json` before `--dry-run`. `destructive: true` iff `--dry-run` is declared. `creek doctor --dry-run` is `unknown_flag`.
- Non-interactive `creek deploy` without `--dry-run` / `--sandbox` / `--prod` / `--yes` exits with `confirmation_required`. Do not treat that as a successful deploy proof.
- `--yes` is not implied by `--json`.
- One disposable project dir per drive. Do not reuse another run's scratch.
- Capture argv, stdout, stderr, exit code, and cwd/HOME file deltas.

## Proof standards

A drive is proven when:

1. Evidence is under `.cursor/skills/verify-creek/artifacts/$RUN_ID/drive/` (not only the terminal).
2. JSON stdout parses; asserted fields match the feature file.
3. Side effects were **observed** (file tree and isolated HOME), not assumed from flag names.
4. Cleanup deleted `/tmp/creek-verify-$RUN_ID` and **left artifacts in place**.
5. No production credentials were used; no shared live deployment was driven.

`unmet-precondition` (exit 2 from `drive.sh`) is a valid recorded outcome for auth-gated paths. It is not a pass for auth-free features.
