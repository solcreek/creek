#!/usr/bin/env bash
# Environment doctor: can this agent invoke the real Creek CLI?
# This is NOT `creek doctor` (that is features/doctor.md). Fail closed.
# Usage: .cursor/skills/verify-creek/scripts/doctor.sh

set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ensure_node_path
ensure_run
cd "${REPO_ROOT}"

DOC_DIR="${ARTIFACTS}/doctor"
mkdir -p "${DOC_DIR}"

fail() {
  python3 -c "import json,sys; json.dump({'ok': False, 'error': sys.argv[1], 'message': sys.argv[2]}, open('${DOC_DIR}/report.json','w'), indent=2)" "$1" "$2"
  echo "doctor: $1 — $2" >&2
  exit 1
}

command -v node >/dev/null || fail "node_missing" "node not on PATH"
command -v pnpm >/dev/null || fail "pnpm_missing" "pnpm not on PATH"

JS="$(creek_js)"
[[ -f "${JS}" ]] || fail "cli_dist_missing" "Run ${SKILL_DIR}/scripts/launch.sh — missing ${JS}"

set +e
node "${JS}" --version >"${DOC_DIR}/version.stdout" 2>"${DOC_DIR}/version.stderr"
VER_EXIT=$?
node "${JS}" --help --json >"${DOC_DIR}/help.stdout" 2>"${DOC_DIR}/help.stderr"
HELP_EXIT=$?
set -e

python3 - <<PY
import json, pathlib, sys
doc = pathlib.Path("${DOC_DIR}")
report = {"ok": True, "checks": []}

def check(name, ok, **extra):
    item = {"name": name, "ok": bool(ok), **extra}
    report["checks"].append(item)
    if not ok:
        report["ok"] = False

check("node", True, version="""$(node -v)""", path="""$(command -v node)""")
check("pnpm", True, version="""$(pnpm --version)""")
check("creek_js_exists", True, path="${JS}")
check("creek_version_exit", ${VER_EXIT} == 0, exitCode=${VER_EXIT}, stdout=(doc/"version.stdout").read_text().strip())

raw = (doc/"help.stdout").read_text()
try:
    schema = json.loads(raw)
except json.JSONDecodeError as e:
    check("help_json", False, error=str(e))
    (doc/"report.json").write_text(json.dumps(report, indent=2) + "\n")
    sys.exit(1)

cmd = schema.get("command") or {}
subs = {c.get("name") for c in cmd.get("subcommands") or []}
needed = {"init", "deploy", "doctor", "whoami"}
check("help_json_ok", schema.get("ok") is True and ${HELP_EXIT} == 0, exitCode=${HELP_EXIT})
check("command_name", cmd.get("name") == "creek", observed=cmd.get("name"))
check("required_subcommands", needed <= subs, missing=sorted(needed - subs))
check("root_not_destructive", cmd.get("destructive") is False)

(doc/"help-schema.json").write_text(json.dumps(schema, indent=2) + "\n")
(doc/"report.json").write_text(json.dumps(report, indent=2) + "\n")
sys.exit(0 if report["ok"] else 1)
PY
