# Deploy dry-run

Deploy dry-run prints the deploy plan for the current directory without building, uploading, or calling the network. It is the agent-safe preview of `creek deploy`.

## Sub-features

- `dry-run-static` reports `wouldDeploy: true` for a directory with `index.html`.
- `dry-run-empty` reports `wouldDeploy: false` for a tree with nothing deployable.
- `dry-run-toml-only` reports `wouldDeploy: false` for `creek.toml` alone.
- `dry-run-target-sandbox` selects sandbox when unsigned-in.
- `dry-run-no-network` succeeds while API URLs connection-refuse and writes no `~/.creek/config.json`.
- `deploy-confirmation-gate` refuses a bare non-TTY `creek deploy` with `confirmation_required`.

## How to get to it (user POV)

- Run `creek deploy --dry-run`.
- Run `creek deploy --dry-run --json` for the machine-readable plan.
- Run `creek deploy <dir> --dry-run` to plan an explicit directory.
- Run `creek deploy` with no target flags in a non-interactive environment (refused).

## Driving it with verify-creek

Preconditions:

- `doctor.sh` reports a clean isolated home, `CREEK_TOKEN` unset, and API URLs `http://127.0.0.1:1`.
- Start from an empty `$VERIFY_CREEK_WORK`.

- **Empty tree.** Preview with nothing to upload. Run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/deploy-dry-run/empty -- deploy --dry-run --json`. Exit code `0`. stdout JSON has `mode: "dry-run"`, `supported: true`, `wouldDeploy: false`, `authenticated: false`, `target.type: "sandbox"`, and a finding with `code: "CK-NO-CONFIG"`.
- **Toml only.** Write only `creek.toml` with `[project]\nname = "verify-fixture"\n`, then re-run the same command into `artifacts/deploy-dry-run/toml-only`. Exit code `0`. `wouldDeploy` is `false`. `nextStep` mentions `index.html` and `--sandbox`.
- **Static payload.** Write `$VERIFY_CREEK_WORK/index.html` containing `<h1>verify-creek</h1>`, then run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/deploy-dry-run/static -- deploy --dry-run --json`. Exit code `0`. `wouldDeploy` is `true`, `target.type` is `sandbox`, `nextStep` is `creek deploy --sandbox --json`.
- **No network.** Same successful run: `sideEffects.networkCalls` is `false`, `sideEffects.fileUploads` is `false`, `sideEffects.buildExecuted` is `false`. The command returned 0 with `CREEK_API_URL=http://127.0.0.1:1`. `$HOME/.creek/config.json` is absent. Copy `env.txt` from the evidence directory (it records the dead URL).
- **Confirmation gate.** From the same static tree, run `creek.sh "$RUN_ENV" --evidence .cursor/skills/verify-creek/artifacts/deploy-dry-run/gate -- deploy --json` (no `--dry-run`, no `--sandbox`, no `--prod`, no `--yes`). Exit code `1`. stdout JSON has `ok: false` and `error: "confirmation_required"`. The work directory still contains only the files you wrote; nothing was uploaded.
- **Proof.** Keep the `static` stdout (plan + `wouldDeploy: true`) and `gate` stdout (`confirmation_required`) plus `env.txt` showing the dead API URL.

## Gotchas

- `--dry-run` with `--template`, `--from-github`, or a GitHub repo URL returns `supported: false` and does not plan. That is not a failed dry-run of a local tree.
- Signed-in dry-run would set `target.type` to `production` unless `--sandbox` is passed. This harness unsets `CREEK_TOKEN` so the default target is sandbox. A leaked token invalidates the sandbox assertion.
- `wouldDeploy: true` is not a deploy. Do not follow `nextStep` (`creek deploy --sandbox --json`) during this feature; that hits the public sandbox API.
- The `confirmation_required` gate applies when stdout is not a TTY and the command has none of `--yes`, `--prod`, or `--sandbox`. This harness redirects stdout, so `creek deploy --json` exits 1 with that error. A signed-out TTY continues toward a sandbox deploy. A first-time Terms prompt can still appear on that path.
- `creek.toml` is not a deployable payload by itself. Assert `wouldDeploy: false` on the toml-only tree before adding `index.html`.
- On macOS the plan's `cwd` is often the `/private/var/folders/...` real path of `$VERIFY_CREEK_WORK`. Compare with `realpath`, not the path `launch.sh` printed.
