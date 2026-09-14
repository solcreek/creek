#!/usr/bin/env bash
# Drive one mapped Creek CLI feature (or a raw argv) and store evidence.
# Usage:
#   .cursor/skills/verify-creek/scripts/drive.sh <feature-id>
#   .cursor/skills/verify-creek/scripts/drive.sh --raw [--cwd DIR] -- <creek-args...>
# Feature ids: help-schema | init | doctor | deploy-dry-run | whoami

set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ensure_node_path
ensure_pnpm
ensure_run
require_creek_js
cd "${REPO_ROOT}"

FEATURE="${1:-}"
if [[ -z "${FEATURE}" ]]; then
  echo "usage: drive.sh <help-schema|init|doctor|deploy-dry-run|whoami>" >&2
  echo "       drive.sh --raw [--cwd DIR] -- <creek-args...>" >&2
  exit 2
fi

JS="$(creek_js)"
DRIVE_ROOT="${ARTIFACTS}/drive"

run_one() {
  local label="$1"
  local cwd="$2"
  shift 2
  local dest="${DRIVE_ROOT}/${label}"
  mkdir -p "${dest}"
  snapshot_tree "${cwd}" "${dest}/tree-before.json"
  snapshot_tree "${ISOLATED_HOME}" "${dest}/home-before.json"
  local rc=0
  capture_cmd "${dest}" "${cwd}" -- node "${JS}" "$@" || rc=$?
  snapshot_tree "${cwd}" "${dest}/tree-after.json"
  snapshot_tree "${ISOLATED_HOME}" "${dest}/home-after.json"
  write_side_effects "${dest}" "${cwd}"
  return "${rc}"
}

write_feature_summary() {
  local feature="$1"
  python3 - <<PY
import json, pathlib, sys
root = pathlib.Path("${DRIVE_ROOT}")
feature = "${feature}"
steps = []
for child in sorted(p for p in root.iterdir() if p.is_dir()):
    meta_p = child / "meta.json"
    if not meta_p.exists():
        continue
    meta = json.loads(meta_p.read_text())
    stdout = (child/"stdout").read_text() if (child/"stdout").exists() else ""
    parsed = None
    parse_error = None
    try:
        parsed = json.loads(stdout) if stdout.strip().startswith("{") else None
    except json.JSONDecodeError as e:
        parse_error = str(e)
    side = {}
    if (child/"side-effects.json").exists():
        side = json.loads((child/"side-effects.json").read_text())
    argv = json.loads((child/"argv.json").read_text()) if (child/"argv.json").exists() else {}
    slim = None
    if isinstance(parsed, dict):
        slim = {k: parsed[k] for k in ("ok", "error", "flags", "path", "mode", "authenticated") if k in parsed}
        cmd = parsed.get("command")
        if isinstance(cmd, dict):
            slim["command"] = {
                "name": cmd.get("name"),
                "destructive": cmd.get("destructive"),
                "dryRun": cmd.get("dryRun"),
            }
    steps.append({
        "label": child.name,
        "argv": argv.get("argv"),
        "exitCode": meta.get("exitCode"),
        "cwd": meta.get("cwd"),
        "stdoutJson": slim,
        "stdoutParseError": parse_error,
        "stdoutBytes": len(stdout),
        "sideEffects": side,
    })
summary = {"ok": True, "feature": feature, "runId": "${RUN_ID}", "steps": steps}
(root/"summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({"feature": feature, "steps": [s["label"] for s in steps]}, indent=2))
PY
}

assert_json() {
  python3 - "$@" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
expect_exit = int(sys.argv[2])
actual_exit = int(pathlib.Path(sys.argv[1]).parent.joinpath("exit_code").read_text().strip())
checks = sys.argv[3:]  # dotted.path=value  (value is JSON)
data = json.loads(path.read_text())
errors = []
if actual_exit != expect_exit:
    errors.append(f"exit {actual_exit} != {expect_exit}")
def dig(obj, dotted):
    cur = obj
    for part in dotted.split("."):
        if part.endswith("]"):
            name, rest = part.split("[", 1)
            idx = int(rest[:-1])
            cur = cur[name][idx]
        else:
            cur = cur[part]
    return cur
for item in checks:
    dotted, raw = item.split("=", 1)
    expected = json.loads(raw)
    try:
        got = dig(data, dotted)
    except Exception as e:
        errors.append(f"{dotted}: missing ({e})")
        continue
    if got != expected:
        errors.append(f"{dotted}: {got!r} != {expected!r}")
if errors:
    print("assert failed:", file=sys.stderr)
    for e in errors:
        print(" -", e, file=sys.stderr)
    sys.exit(1)
PY
}

case "${FEATURE}" in
  --raw)
    shift
    cwd="${SCRATCH}/projects/raw"
    mkdir -p "${cwd}"
    if [[ "${1:-}" == "--cwd" ]]; then
      cwd="$2"
      shift 2
    fi
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    rc=0
    run_one "raw" "${cwd}" "$@" || rc=$?
    write_feature_summary "raw"
    exit "${rc}"
    ;;

  help-schema)
    mkdir -p "${DRIVE_ROOT}"
    proj="${SCRATCH}/projects/help-schema"
    mkdir -p "${proj}"
    run_one "01-root-help" "${proj}" --help --json
    run_one "02-doctor-help" "${proj}" doctor --help --json
    run_one "03-deploy-help" "${proj}" deploy --help --json
    run_one "04-doctor-unknown-dry-run" "${proj}" doctor --dry-run --json || true
    assert_json "${DRIVE_ROOT}/01-root-help/stdout" 0 'ok=true' 'command.name="creek"' 'command.destructive=false'
    assert_json "${DRIVE_ROOT}/02-doctor-help/stdout" 0 'command.name="doctor"' 'command.destructive=false' 'command.dryRun=false'
    assert_json "${DRIVE_ROOT}/03-deploy-help/stdout" 0 'command.name="deploy"' 'command.destructive=true' 'command.dryRun=true'
    assert_json "${DRIVE_ROOT}/04-doctor-unknown-dry-run/stdout" 1 'ok=false' 'error="unknown_flag"'
    write_feature_summary "help-schema"
    ;;

  init)
    proj="${SCRATCH}/projects/init"
    mkdir -p "${proj}"
    # init writes creek.toml in cwd; positional is the project name.
    run_one "01-init-json" "${proj}" init --json --yes verify-init
    assert_json "${DRIVE_ROOT}/01-init-json/stdout" 0 'ok=true' 'name="verify-init"'
    python3 - <<PY
import json, pathlib, sys
proj = pathlib.Path("${proj}")
toml = proj / "creek.toml"
side = json.loads(pathlib.Path("${DRIVE_ROOT}/01-init-json/side-effects.json").read_text())
ok = toml.is_file() and 'name = "verify-init"' in toml.read_text()
report = {
  "creekTomlExists": toml.is_file(),
  "creekTomlPath": str(toml),
  "containsName": 'name = "verify-init"' in toml.read_text() if toml.is_file() else False,
  "filesAdded": side.get("filesAdded"),
}
pathlib.Path("${DRIVE_ROOT}/01-init-json/proof.json").write_text(json.dumps(report, indent=2) + "\n")
sys.exit(0 if ok else 1)
PY
    write_feature_summary "init"
    ;;

  doctor)
    empty="${SCRATCH}/projects/doctor-empty"
    fixture="${SCRATCH}/projects/doctor-static"
    mkdir -p "${empty}" "${fixture}"
    printf '<h1>creek-verify</h1>\n' > "${fixture}/index.html"
    run_one "01-empty" "${empty}" doctor --json "${empty}" || true
    run_one "02-static" "${fixture}" doctor --json "${fixture}"
    assert_json "${DRIVE_ROOT}/01-empty/stdout" 1 'ok=false' 'findings[0].code="CK-NO-CONFIG"'
    assert_json "${DRIVE_ROOT}/02-static/stdout" 0 'ok=true'
    python3 - <<PY
import json, pathlib, sys
static = json.loads(pathlib.Path("${DRIVE_ROOT}/02-static/stdout").read_text())
needed = {"ok", "cwd", "archetype", "summary", "findings"}
missing = sorted(needed - set(static))
shape = {
  "hasRequiredKeys": not missing,
  "missing": missing,
  "summaryKeys": sorted((static.get("summary") or {}).keys()),
  "findingsIsList": isinstance(static.get("findings"), list),
}
pathlib.Path("${DRIVE_ROOT}/02-static/proof.json").write_text(json.dumps(shape, indent=2) + "\n")
sys.exit(0 if not missing and shape["findingsIsList"] else 1)
PY
    write_feature_summary "doctor"
    ;;

  deploy-dry-run)
    fixture="${SCRATCH}/projects/deploy-dry-run"
    mkdir -p "${fixture}"
    printf '<h1>creek-verify-deploy</h1>\n' > "${fixture}/index.html"
    run_one "01-dry-run" "${fixture}" deploy --dry-run --json "${fixture}"
    assert_json "${DRIVE_ROOT}/01-dry-run/stdout" 0 'mode="dry-run"' 'supported=true' 'wouldDeploy=true' 'sideEffects.networkCalls=false' 'sideEffects.fileUploads=false' 'sideEffects.buildExecuted=false'
    python3 - <<PY
import json, pathlib, sys
dest = pathlib.Path("${DRIVE_ROOT}/01-dry-run")
plan = json.loads((dest/"stdout").read_text())
side = json.loads((dest/"side-effects.json").read_text())
# Dry-run must not add/remove/modify project files or isolated HOME (incl. in-place writes).
proof = {
  "wouldDeploy": plan.get("wouldDeploy"),
  "targetType": (plan.get("target") or {}).get("type"),
  "authenticated": plan.get("authenticated"),
  "sideEffectsDeclared": plan.get("sideEffects"),
  "filesAddedInProject": side.get("filesAdded"),
  "filesRemovedInProject": side.get("filesRemoved"),
  "filesModifiedInProject": side.get("filesModified"),
  "isolatedHomeFilesAdded": side.get("isolatedHomeFilesAdded"),
  "isolatedHomeFilesRemoved": side.get("isolatedHomeFilesRemoved"),
  "isolatedHomeFilesModified": side.get("isolatedHomeFilesModified"),
  "observedNoProjectMutation": side.get("observedNoProjectMutation") is True,
  "observedNoHomeMutation": side.get("observedNoHomeMutation") is True,
}
(dest/"proof.json").write_text(json.dumps(proof, indent=2) + "\n")
ok = (
    proof["observedNoProjectMutation"]
    and proof["observedNoHomeMutation"]
    and plan.get("sideEffects", {}).get("networkCalls") is False
)
sys.exit(0 if ok else 1)
PY
    write_feature_summary "deploy-dry-run"
    ;;

  whoami)
    proj="${SCRATCH}/projects/whoami"
    mkdir -p "${proj}"
    if [[ "${VERIFY_CREEK_ALLOW_AUTH:-}" == "1" ]]; then
      if [[ -z "${VERIFY_CREEK_TOKEN:-}" ]]; then
        python3 - <<PY
import json, pathlib
p = pathlib.Path("${DRIVE_ROOT}")
p.mkdir(parents=True, exist_ok=True)
report = {
  "ok": False,
  "error": "unmet-precondition",
  "message": "VERIFY_CREEK_ALLOW_AUTH=1 requires VERIFY_CREEK_TOKEN (a scoped non-production token). Parent CREEK_TOKEN is never inherited. Do not double-drive a shared live deployment.",
}
(p/"summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
PY
        exit 2
      fi
      CAPTURE_PASS_TOKEN=1 run_one "01-authenticated" "${proj}" whoami --json
      assert_json "${DRIVE_ROOT}/01-authenticated/stdout" 0 'ok=true' 'authenticated=true'
      write_feature_summary "whoami"
    else
      # Parent CREEK_TOKEN is ignored (capture unsets it). Default proof is unauthenticated.
      run_one "01-unauthenticated" "${proj}" whoami --json || true
      assert_json "${DRIVE_ROOT}/01-unauthenticated/stdout" 1 'ok=false' 'authenticated=false' 'error="not_authenticated"'
      write_feature_summary "whoami"
    fi
    ;;

  *)
    echo "unknown feature: ${FEATURE}" >&2
    echo "mapped: help-schema init doctor deploy-dry-run whoami" >&2
    exit 2
    ;;
esac
