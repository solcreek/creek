# doctor

`creek doctor --json` runs the SDK rule engine on a project directory (positional `path`, default cwd). Exit 0 iff `ok: true` (zero error-severity findings). Warnings do not fail the process. This is the agent pre-deploy check; it is not the skill’s environment `scripts/doctor.sh`.

## Sub-features

- Empty tree: `creek doctor --json <empty>` → exit 1, `{ ok: false, findings: [{ code: "CK-NO-CONFIG", severity: "error", ... }], summary: { error, warn, info } }`.
- Minimal static fixture (`index.html` only): exit 0, `{ ok: true, cwd, archetype, summary, findings: [] }`.
- `--last` diagnoses a failed cloud deployment (auth + project). **Skip** with unmet-precondition unless a documented non-production token is provided.
- Human mode prints to stdout; `--json` keeps stdout parseable (optional one-line summary on stderr when stderr is a TTY).

## How to get to it (user POV)

```bash
cd my-app
creek doctor --json
# or
creek doctor --json /path/to/app
```

Users run it before `creek deploy`. Agents should follow `fix` strings on `CK-*` codes.

## Driving it with drive.sh

```bash
.cursor/skills/verify-creek/scripts/drive.sh doctor
```

1. Empty dir under scratch → `doctor --json <empty>` → assert exit 1, `findings[0].code=="CK-NO-CONFIG"`.
2. Fixture with only `index.html` → `doctor --json <fixture>` → assert exit 0, `ok: true`, keys `ok/cwd/archetype/summary/findings`, `findings` is a list.

No network. `--last` is not driven.

## Gotchas

- `ok` is false only on errors; a warning-only report still exits 0.
- `creek doctor --dry-run` is `unknown_flag` (`destructive: false`).
- Passing the path as a positional is required when cwd is not the fixture; `drive.sh` passes the absolute fixture path.
- Do not substitute `packages/sdk` vitest doctor fixtures for this drive — still invoke the CLI binary.
