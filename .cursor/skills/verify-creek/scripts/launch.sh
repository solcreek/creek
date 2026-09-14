#!/usr/bin/env bash
# Build @solcreek/sdk + @solcreek/cli so the real Creek CLI binary exists.
# Usage: .cursor/skills/verify-creek/scripts/launch.sh
# Evidence: $ARTIFACTS/launch/

set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ensure_node_path
ensure_pnpm
ensure_run
cd "${REPO_ROOT}"

LAUNCH_DIR="${ARTIFACTS}/launch"
mkdir -p "${LAUNCH_DIR}"

{
  echo "node=$(node -v) path=$(command -v node)"
  echo "pnpm=$(pnpm --version) path=$(command -v pnpm)"
  echo "repo=${REPO_ROOT}"
} | tee "${LAUNCH_DIR}/env.txt"

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi

build_cli() {
  # CI (Node 24) uses this filter pair. On Node 22 without the optional tsdown
  # peer `unrun`, tsdown's auto config-loader fails — fall back to native.
  if pnpm --filter @solcreek/sdk --filter @solcreek/cli build; then
    echo "build=pnpm --filter @solcreek/sdk --filter @solcreek/cli build"
    return 0
  fi
  echo "CI build failed; retrying tsdown --config-loader native" >&2
  pnpm --filter @solcreek/sdk exec tsdown --config-loader native
  pnpm --filter @solcreek/cli exec tsdown --config-loader native
  echo "build=pnpm --filter @solcreek/sdk exec tsdown --config-loader native && pnpm --filter @solcreek/cli exec tsdown --config-loader native"
}

BUILD_LINE="$(build_cli | tee "${LAUNCH_DIR}/build.txt" | tail -n 1)"

JS="$(creek_js)"
if [[ ! -f "${JS}" ]]; then
  echo "launch failed: ${JS} not written" >&2
  exit 1
fi

# Verified invoke (this is the command the rest of the skill uses):
set +e
node "${JS}" --help --json >"${LAUNCH_DIR}/help.stdout" 2>"${LAUNCH_DIR}/help.stderr"
HELP_EXIT=$?
set -e
printf '%s\n' "${HELP_EXIT}" > "${LAUNCH_DIR}/help.exit_code"

python3 - <<PY
import json, pathlib, sys
p = pathlib.Path("${LAUNCH_DIR}/help.stdout")
raw = p.read_text()
try:
    data = json.loads(raw)
except json.JSONDecodeError as e:
    pathlib.Path("${LAUNCH_DIR}/meta.json").write_text(json.dumps({
        "ok": False,
        "error": "help_json_unparseable",
        "message": str(e),
        "verifiedInvoke": "node packages/cli/dist/index.js --help --json",
        "build": """${BUILD_LINE}""",
    }, indent=2) + "\n")
    sys.exit(1)
ok = data.get("ok") is True and data.get("command", {}).get("name") == "creek"
meta = {
    "ok": ok,
    "helpExit": ${HELP_EXIT},
    "verifiedInvoke": "node packages/cli/dist/index.js --help --json",
    "creekJs": "${JS}",
    "facadeInvoke": "node packages/creek/bin.js --help --json",
    "build": """${BUILD_LINE}""",
    "commandName": data.get("command", {}).get("name"),
    "subcommandNames": [c.get("name") for c in data.get("command", {}).get("subcommands", [])],
}
pathlib.Path("${LAUNCH_DIR}/meta.json").write_text(json.dumps(meta, indent=2) + "\n")
sys.exit(0 if ok and ${HELP_EXIT} == 0 else 1)
PY
