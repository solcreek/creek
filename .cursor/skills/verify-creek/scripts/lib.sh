#!/usr/bin/env bash
# Shared paths and capture helpers for verify-creek.
# Sourced by launch.sh / doctor.sh / drive.sh / cleanup.sh — not invoked directly.

set -euo pipefail

_verify_creek_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${_verify_creek_lib_dir}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_DIR}/../../.." && pwd)"
ARTIFACTS_ROOT="${SKILL_DIR}/artifacts"
SCRATCH_ROOT="/tmp"

require_python3() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "unmet-precondition: python3 is required for JSON evidence and hash snapshots" >&2
    return 2
  fi
}

# tsdown / this skill: ^22.18.0 || >=24.11.0 (reject 23.x and 24.0–24.10).
node_satisfies_tsdown() {
  python3 - <<'PY'
import os, sys
ver = os.popen("node -p process.versions.node").read().strip()
parts = ver.split(".")
try:
    major, minor = int(parts[0]), int(parts[1])
except (ValueError, IndexError):
    sys.exit(1)
ok = (major == 22 and minor >= 18) or (major == 24 and minor >= 11) or major > 24
sys.exit(0 if ok else 1)
PY
}

ensure_node_path() {
  require_python3
  if command -v node >/dev/null 2>&1 && node_satisfies_tsdown; then
    return 0
  fi
  local nvm_node="${NVM_DIR:-${HOME}/.nvm}/versions/node/v22.22.2/bin"
  if [[ -x "${nvm_node}/node" ]]; then
    export PATH="${nvm_node}:${PATH}"
    hash -r 2>/dev/null || true
  fi
  if ! command -v node >/dev/null 2>&1 || ! node_satisfies_tsdown; then
    echo "unmet-precondition: Node must be ^22.18.0 || >=24.11.0 (got $(node -v 2>/dev/null || echo none))" >&2
    return 2
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    echo "unmet-precondition: pnpm not on PATH and corepack is unavailable" >&2
    return 2
  fi
  pnpm() {
    (
      cd "${REPO_ROOT}"
      exec corepack pnpm "$@"
    )
  }
}

# Safe basename: letters, digits, dot, underscore, hyphen. No slashes, no `..`.
validate_basename() {
  local id="${1:-}"
  local what="${2:-name}"
  if [[ -z "${id}" ]]; then
    echo "invalid ${what}: empty" >&2
    return 2
  fi
  if [[ "${id}" == "." || "${id}" == ".." || "${id}" == *"/"* || "${id}" == *"\\"* ]]; then
    echo "invalid ${what}: must be a single path segment (got ${id})" >&2
    return 2
  fi
  if [[ ! "${id}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "invalid ${what}: only [A-Za-z0-9._-] allowed (got ${id})" >&2
    return 2
  fi
}

validate_run_id() {
  validate_basename "${1:-}" "RUN_ID"
}

# Launch/doctor/drive: never auto-load committed artifacts/LAST_RUN_ID.
# Unset RUN_ID → generate a fresh id. The same explicit RUN_ID is reused across
# launch → doctor → drive. A dir that already has cleanup.json is a finished
# sample and must not be overwritten.
ensure_run() {
  require_python3
  if [[ -z "${RUN_ID:-}" ]]; then
    RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  validate_run_id "${RUN_ID}"
  export RUN_ID
  SCRATCH="${SCRATCH_ROOT}/creek-verify-${RUN_ID}"
  ARTIFACTS="${ARTIFACTS_ROOT}/${RUN_ID}"
  ISOLATED_HOME="${SCRATCH}/home"
  if [[ -f "${ARTIFACTS}/cleanup.json" ]]; then
    echo "refusing RUN_ID ${RUN_ID}: artifacts already have cleanup.json (finished sample). Export a fresh RUN_ID." >&2
    return 2
  fi
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

# Cleanup only: require an explicit RUN_ID (argv or env). Never read LAST_RUN_ID
# — that pointer is shared and can name a different live run.
resolve_run_for_cleanup() {
  require_python3
  if [[ -z "${RUN_ID:-}" ]]; then
    echo "cleanup.sh: set RUN_ID via argv or env (LAST_RUN_ID is not used)" >&2
    return 2
  fi
  validate_run_id "${RUN_ID}"
  export RUN_ID
  SCRATCH="${SCRATCH_ROOT}/creek-verify-${RUN_ID}"
  ARTIFACTS="${ARTIFACTS_ROOT}/${RUN_ID}"
  ISOLATED_HOME="${SCRATCH}/home"
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

# Isolated Creek child: disposable HOME, never inherit parent Creek auth env.
# Opt-in auth: CAPTURE_PASS_TOKEN=1 copies VERIFY_CREEK_TOKEN into CREEK_TOKEN
# for the child only; VERIFY_CREEK_TOKEN itself is always unset in the child.
clear_creek_auth_env() {
  env -u CREEK_TOKEN -u CREEKD_TOKEN -u CREEKCTL_TOKEN -u VERIFY_CREEK_TOKEN "$@"
}

isolated_env() {
  local pass_token=""
  if [[ "${CAPTURE_PASS_TOKEN:-}" == "1" ]]; then
    pass_token="${VERIFY_CREEK_TOKEN-}"
    if [[ -z "${pass_token}" ]]; then
      echo "CAPTURE_PASS_TOKEN=1 requires VERIFY_CREEK_TOKEN" >&2
      return 2
    fi
  fi
  if [[ -n "${pass_token}" ]]; then
    clear_creek_auth_env \
      HOME="${ISOLATED_HOME}" \
      CREEK_API_URL="${CREEK_API_URL:-https://api.creek.dev}" \
      CREEK_TOKEN="${pass_token}" \
      "$@"
  else
    clear_creek_auth_env \
      HOME="${ISOLATED_HOME}" \
      CREEK_API_URL="${CREEK_API_URL:-https://api.creek.dev}" \
      "$@"
  fi
}

resolve_scratch_project_dir() {
  local requested="${1:-raw}"
  python3 - "${SCRATCH}/projects" "${requested}" <<'PY'
import pathlib, sys

root = pathlib.Path(sys.argv[1])
requested = sys.argv[2]
if root.is_symlink():
    print("invalid --cwd: scratch projects root is a symlink", file=sys.stderr)
    raise SystemExit(2)
if not root.exists():
    root.mkdir(parents=True, exist_ok=True)
if root.is_symlink() or not root.is_dir():
    print("invalid --cwd: scratch projects root is not a real directory", file=sys.stderr)
    raise SystemExit(2)

candidate = pathlib.Path(requested)
if candidate.is_absolute():
    target = candidate
else:
    parts = pathlib.PurePosixPath(requested).parts
    if any(p == ".." for p in parts):
        print("invalid --cwd: '..' is not allowed", file=sys.stderr)
        raise SystemExit(2)
    target = root.joinpath(*parts) if parts else root

try:
    rel = target.relative_to(root)
except ValueError:
    print(f"invalid --cwd: {target} is outside {root}", file=sys.stderr)
    raise SystemExit(2)
if any(p == ".." for p in rel.parts):
    print("invalid --cwd: '..' is not allowed", file=sys.stderr)
    raise SystemExit(2)

acc = root
for part in rel.parts:
    acc = acc / part
    if acc.exists() and acc.is_symlink():
        print(f"invalid --cwd: symlink in path: {acc}", file=sys.stderr)
        raise SystemExit(2)
acc.mkdir(parents=True, exist_ok=True)
if acc.is_symlink():
    print(f"invalid --cwd: resolved path is a symlink: {acc}", file=sys.stderr)
    raise SystemExit(2)
print(acc)
PY
}

record_pid() {
  local name="$1"
  local pid="$2"
  validate_basename "${name}" "record_pid name" || return 2
  [[ "${pid}" =~ ^[0-9]+$ ]] || {
    echo "record_pid: pid must be numeric (got ${pid})" >&2
    return 2
  }
  python3 - "${SCRATCH}/pids" "${name}" "${pid}" <<'PY'
import json, pathlib, sys

def start_ticks(pid: str) -> int:
    raw = pathlib.Path(f"/proc/{pid}/stat").read_text()
    close = raw.rfind(")")
    if close < 0:
        raise SystemExit(f"record_pid: /proc/{pid}/stat missing comm")
    rest = raw[close + 1 :].split()
    # Field 22 starttime is rest[19] after parsing comm via the closing ')'.
    if len(rest) < 20:
        raise SystemExit(f"record_pid: short /proc/{pid}/stat")
    return int(rest[19])

pids_dir_raw = pathlib.Path(sys.argv[1])
name = sys.argv[2]
pid = sys.argv[3]
if pids_dir_raw.is_symlink():
    raise SystemExit("record_pid: pids dir is a symlink")
pids_dir = pids_dir_raw.resolve()
path = (pids_dir / name).resolve()
try:
    path.relative_to(pids_dir)
except ValueError:
    raise SystemExit(f"record_pid: {path} is outside {pids_dir}")
if path.is_symlink():
    raise SystemExit(f"record_pid: refusing symlink {path}")
stat = pathlib.Path(f"/proc/{pid}/stat")
cmdline = pathlib.Path(f"/proc/{pid}/cmdline")
if not stat.is_file():
    raise SystemExit(f"record_pid: /proc/{pid}/stat missing")
payload = {
    "pid": int(pid),
    "startTicks": start_ticks(pid),
    "cmdline": cmdline.read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace").strip(),
}
path.write_text(json.dumps(payload, indent=2) + "\n")
PY
}

# JSON map of relpath -> {type, sha256, bytes} so in-place writes are visible.
# Fail closed if the watched tree contains any symlink (file or directory):
# link targets are not hashed, and a symlink can point outside scratch.
snapshot_tree() {
  local dir="$1"
  local out="$2"
  mkdir -p "$(dirname "${out}")"
  python3 - "${dir}" "${out}" <<'PY'
import hashlib, json, os, sys
root, out = sys.argv[1], sys.argv[2]
entries = {}
symlinks = []

def relpath(dirpath, name):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == ".":
        rel_dir = ""
    return name if rel_dir == "" else f"{rel_dir}/{name}"

if os.path.islink(root):
    print(f"snapshot refused: watched root is a symlink: {root}", file=sys.stderr)
    raise SystemExit(2)
if not os.path.isdir(root):
    print(f"snapshot refused: watched root missing: {root}", file=sys.stderr)
    raise SystemExit(2)
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    for name in list(dirnames):
        path = os.path.join(dirpath, name)
        rel = relpath(dirpath, name)
        if os.path.islink(path):
            symlinks.append(rel)
            continue
        entries[rel] = {"type": "dir"}
    for name in sorted(filenames):
        path = os.path.join(dirpath, name)
        rel = relpath(dirpath, name)
        if os.path.islink(path):
            symlinks.append(rel)
            continue
        raw = open(path, "rb").read()
        entries[rel] = {
            "type": "file",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        }
if symlinks:
    print(
        "snapshot refused: symlinks in watched tree (fail closed): " + ", ".join(sorted(symlinks)),
        file=sys.stderr,
    )
    raise SystemExit(2)
open(out, "w").write(json.dumps(entries, indent=2, sort_keys=True) + "\n")
txt = out.rsplit(".", 1)[0] + ".txt"
lines = []
for rel, meta in sorted(entries.items()):
    if meta.get("type") == "file":
        lines.append(f"{rel}\t{meta['sha256']}\t{meta['bytes']}")
    else:
        lines.append(f"{rel}\tdir")
open(txt, "w").write("\n".join(lines) + ("\n" if lines else ""))
PY
}

write_side_effects() {
  local dest="$1"
  local cwd="$2"
  python3 - "${dest}" "${cwd}" <<'PY'
import json, pathlib, sys
dest, cwd = pathlib.Path(sys.argv[1]), sys.argv[2]

def diff(before_p, after_p):
    before = json.loads(before_p.read_text()) if before_p.exists() else {}
    after = json.loads(after_p.read_text()) if after_p.exists() else {}
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    modified = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    return added, removed, modified

def touches_creek_config(paths):
    for rel in paths:
        if rel == ".creek" or rel.startswith(".creek/"):
            return True
    return False

pa, pr, pm = diff(dest / "tree-before.json", dest / "tree-after.json")
ha, hr, hm = diff(dest / "home-before.json", dest / "home-after.json")
side = {
    "cwd": cwd,
    "filesAdded": pa,
    "filesRemoved": pr,
    "filesModified": pm,
    "isolatedHomeFilesAdded": ha,
    "isolatedHomeFilesRemoved": hr,
    "isolatedHomeFilesModified": hm,
    "observedNoProjectMutation": not (pa or pr or pm),
    "observedNoHomeMutation": not (ha or hr or hm),
    "mutatedDeveloperCreekConfig": touches_creek_config(ha + hr + hm),
}
(dest / "side-effects.json").write_text(json.dumps(side, indent=2) + "\n")
PY
}

redact_argv_json() {
  local path="$1"
  shift
  python3 - "${path}" "$@" <<'PY'
import json, sys
path = sys.argv[1]
argv = sys.argv[2:]
SECRET_EXACT = {"--token", "--creekd-token"}

def secret_flag(flag: str) -> bool:
    if flag in SECRET_EXACT:
        return True
    if flag.startswith("--") and flag.endswith("-token"):
        return True
    return False

out = []
skip_next = False
for token in argv:
    if skip_next:
        out.append("<redacted>")
        skip_next = False
        continue
    if token.startswith("--") and "=" in token:
        flag, _val = token.split("=", 1)
        if secret_flag(flag):
            out.append(f"{flag}=<redacted>")
            continue
    if secret_flag(token):
        out.append(token)
        skip_next = True
        continue
    out.append(token)
open(path, "w").write(json.dumps({"argv": out, "redacted": out != list(argv)}, indent=2) + "\n")
PY
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
  redact_argv_json "${dest}/argv.json" "$@"

  local started ended exit_code node_ver js token_source
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node_ver="$(node -v 2>/dev/null || echo unknown)"
  js="$(creek_js)"
  token_source="none"
  if [[ "${CAPTURE_PASS_TOKEN:-}" == "1" && -n "${VERIFY_CREEK_TOKEN:-}" ]]; then
    token_source="VERIFY_CREEK_TOKEN"
  fi
  set +e
  (
    cd "${cwd}"
    isolated_env "$@"
  ) >"${dest}/stdout" 2>"${dest}/stderr"
  exit_code=$?
  set -e
  ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "${exit_code}" > "${dest}/exit_code"
  python3 - "${dest}/meta.json" "${started}" "${ended}" "${cwd}" "${exit_code}" \
    "${ISOLATED_HOME}" "${node_ver}" "${js}" "${token_source}" <<'PY'
import json, sys
meta = {
  "startedAt": sys.argv[2],
  "endedAt": sys.argv[3],
  "cwd": sys.argv[4],
  "exitCode": int(sys.argv[5]),
  "isolatedHome": sys.argv[6],
  "creekTokenInherited": False,
  "tokenSource": sys.argv[9],
  "node": sys.argv[7],
  "creekJs": sys.argv[8],
}
open(sys.argv[1], "w").write(json.dumps(meta, indent=2) + "\n")
PY
  return "${exit_code}"
}
