# deploy-dry-run

`creek deploy --dry-run` is the mutating deploy command’s preview: resolve config, run the same doctor rules, report `wouldDeploy` and `nextStep`, then exit 0 without ToS, build, upload, or network. `creek deploy --help --json` reports `destructive: true` / `dryRun: true`. Live `--sandbox` / `--prod` are not this feature.

## Sub-features

- Static fixture (`index.html`): `{ mode: "dry-run", supported: true, wouldDeploy: true, authenticated: false, target.type: "sandbox", sideEffects: { networkCalls: false, fileUploads: false, buildExecuted: false, tosPromptShown: false }, nextStep: "creek deploy --sandbox --json" }`.
- `creek.toml` alone is not deployable (`wouldDeploy: false`); `index.html` or `package.json` or a build-output dir is.
- Unsupported dry-run modes (`--template`, `--from-github`, repo URL as dir): `supported: false`, still exit 0 — skip unless adding a dedicated case.
- Bare non-TTY `creek deploy --json` without target flags is `confirmation_required` — do not use that as a dry-run proof.

## How to get to it (user POV)

```bash
cd my-app
creek deploy --dry-run --json
```

Users inspect the plan, then follow `nextStep` (`--sandbox` or `--prod`). Agents must not strip those flags.

## Driving it with drive.sh

```bash
.cursor/skills/verify-creek/scripts/drive.sh deploy-dry-run
```

Writes `index.html` in a scratch project, runs `deploy --dry-run --json <dir>`, asserts JSON `mode/supported/wouldDeploy/authenticated: false/target.type: "sandbox"/nextStep/sideEffects.*`, then **observes** `side-effects.json`: `observedNoProjectMutation` and `observedNoHomeMutation` (added/removed/**modified** hashes, so in-place rewrites of `index.html` or `~/.creek/config.json` fail the proof). JSON `networkCalls: false` is the CLI’s declared contract, not a packet capture.

Do not follow `nextStep` in this drive. Do not pass `--sandbox` here.

## Gotchas

- Dry-run always exits 0 even when `wouldDeploy` is false — assert fields, not “nonzero means failure”.
- Signed-in HOME would report `authenticated: true` and `target.type: "production"` without `--sandbox`. Helpers unset token and isolate HOME so the default proof stays sandbox/unauthenticated.
- `--dry-run` plus `--template` / `--from-github` is `supported: false`; that is not a production deploy, but it is also not a full plan.
- Never assume dry-run skipped network solely because the flag is present; require the JSON `sideEffects` object and the hash snapshots (`filesModified` included).
