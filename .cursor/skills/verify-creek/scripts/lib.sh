#!/usr/bin/env bash
# Shared paths and capture helpers for verify-creek.
# Sourced by launch.sh / doctor.sh / drive.sh / cleanup.sh — not invoked directly.

set -euo pipefail

_verify_creek_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${_verify_creek_lib_dir}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_DIR}/../../.." && pwd)"
ARTIFACTS_ROOT="${SKILL_DIR}/artifacts"
SCRATCH_ROOT="/tmp"

ensure_node_path() {
  # tsdown 0.22.3 engines: ^22.18.0 || >=24.11.0. Some Cloud Agent pods default
  # to Node 22.14.0 via /exec-daemon/node — prefer nvm 22.22.2 when present.
  local major=0 minor=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p "process.versions.node.split('.')[0]")"
    minor="$(node -p "process.versions.node.split('.')[1]")"
  fi
  if [[ "${major}" -gt 22 ]] || { [[ "${major}" -eq 22 ]] && [[ "${minor}" -ge 18 ]]; } || [[ "${major}" -ge 24 ]]; then
    return 0
  fi
  local nvm_node="${NVM_DIR:-${HOME}/.nvm}/versions/node/v22.22.2/bin"
  if [[ -x "${nvm_node}/node" ]]; then
    export PATH="${nvm_node}:${PATH}"
    hash -r 2>/dev/null || true
  fi
}

ensure_run() {
  if [[ -z "${RUN_ID:-}" && -f "${ARTIFACTS_ROOT}/LAST_RUN_ID" ]]; then
    RUN_ID="$(tr -d '[:space:]' < "${ARTIFACTS_ROOT}/LAST_RUN_ID")"
  fi
  if [[ -z "${RUN_ID:-}" ]]; then
    RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  export RUN_ID
  SCRATCH="${SCRATCH_ROOT}/creek-verify-${RUN_ID}"
  ARTIFACTS="${ARTIFACTS_ROOT}/${RUN_ID}"
  ISOLATED_HOME="${SCRATCH}/home"
  mkdir -p "${SCRATCH}/projects" "${ISOLATED_HOME}" "${SCRATCH}/pids" "${ARTIFACTS}" "${ARTIFACTS_ROOT}"
  printf '%s\n' "${RUN_ID}" > "${ARTIFACTS_ROOT}/LAST_RUN_ID"
  python3 - "${RUN_ID}" "${REPO_ROOT}" "${SCRATCH}" "${ARTIFACTS}" "${ISOLATED_HOME}" <<'PY'
import json, sys
payload = {
  "runId": sys.argv[1],
  "repoRoot": sys.argv[2],
  "scratch": sys.argv[3],
  "artifacts": sys.argv[4],
  "isolatedHome": sys.argv[5],
}
open(sys.argv[4] + "/run.json", "w").write(json.dumps(payload, indent=2) + "\n")
PY
}

creek_js() {
  printf '%s\n' "${REPO_ROOT}/packages/cli/dist/index.js"
}

require_creek_js() {
  local js
  js="$(creek_js)"
  if [[ ! -f "${js}" ]]; then
    echo "unmet-precondition: CLI dist missing at ${js}. Run ${SKILL_DIR}/scripts/launch.sh" >&2
    return 2
  fi
}

snapshot_tree() {
  local dir="$1"
  local out="$2"
  mkdir -p "$(dirname "${out}")"
  if [[ -d "${dir}" ]]; then
    (cd "${dir}" && find . -print | sort) > "${out}"
  else
    : > "${out}"
  fi
}

# Capture argv/stdout/stderr/exit into dest_dir.
# Usage: capture_cmd DEST_DIR CWD -- argv...
capture_cmd() {
  local dest="$1"
  local cwd="$2"
  shift 2
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  mkdir -p "${dest}"
  python3 -c "import json,sys; json.dump({'argv': sys.argv[2:]}, open(sys.argv[1],'w'), indent=2)" \
    "${dest}/argv.json" "$@"

  local started ended exit_code node_ver js
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node_ver="$(node -v 2>/dev/null || echo unknown)"
  js="$(creek_js)"
  set +e
  (
    cd "${cwd}"
    env -u CREEK_TOKEN \
      HOME="${ISOLATED_HOME}" \
      CREEK_API_URL="${CREEK_API_URL:-https://api.creek.dev}" \
      "$@"
  ) >"${dest}/stdout" 2>"${dest}/stderr"
  exit_code=$?
  set -e
  ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "${exit_code}" > "${dest}/exit_code"
  python3 - "${dest}/meta.json" "${started}" "${ended}" "${cwd}" "${exit_code}" "${ISOLATED_HOME}" "${node_ver}" "${js}" <<'PY'
import json, sys
meta = {
  "startedAt": sys.argv[2],
  "endedAt": sys.argv[3],
  "cwd": sys.argv[4],
  "exitCode": int(sys.argv[5]),
  "isolatedHome": sys.argv[6],
  "creekTokenInherited": False,
  "node": sys.argv[7],
  "creekJs": sys.argv[8],
}
open(sys.argv[1], "w").write(json.dumps(meta, indent=2) + "\n")
PY
  return "${exit_code}"
}
