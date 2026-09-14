#!/usr/bin/env bash
# Tear down scratch dirs / PIDs / tmux sessions THIS run created.
# Never deletes .cursor/skills/verify-creek/artifacts/.
# Never kill-all by process name.
# Requires python3 only (no Node/pnpm).
# Usage: .cursor/skills/verify-creek/scripts/cleanup.sh <RUN_ID>
#        RUN_ID=<id> .cursor/skills/verify-creek/scripts/cleanup.sh

set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ -n "${1:-}" ]]; then
  RUN_ID="$1"
fi
resolve_run_for_cleanup

CLEANUP_RECORD="${ARTIFACTS}/cleanup.json"

# Idempotent: keep the original evidence. Still remove leftover scratch.
if [[ -f "${CLEANUP_RECORD}" ]]; then
  if [[ -d "${SCRATCH}" ]]; then
    rm -rf "${SCRATCH}"
  fi
  python3 - "${CLEANUP_RECORD}" <<'PY'
import pathlib, sys
sys.stdout.write(pathlib.Path(sys.argv[1]).read_text())
PY
  exit 0
fi

if [[ ! -d "${SCRATCH}" && ! -d "${ARTIFACTS}" ]]; then
  echo "cleanup: no scratch and no artifacts for this RUN_ID" >&2
  exit 2
fi

PIDS_DIR="${SCRATCH}/pids"
TMUX_FILE="${SCRATCH}/tmux-sessions"
TMPDIR_CLEAN="$(mktemp -d /tmp/creek-verify-cleanup-XXXXXX)"
SIGNALS_FILE="${TMPDIR_CLEAN}/pids.json"
SESSIONS_FILE="${TMPDIR_CLEAN}/tmux.json"
SKIPPED_FILE="${TMPDIR_CLEAN}/pids-skipped.json"
python3 -c "import json,sys; json.dump([], open(sys.argv[1],'w'))" "${SIGNALS_FILE}"
python3 -c "import json,sys; json.dump([], open(sys.argv[1],'w'))" "${SESSIONS_FILE}"
python3 -c "import json,sys; json.dump([], open(sys.argv[1],'w'))" "${SKIPPED_FILE}"
trap 'rm -rf "${TMPDIR_CLEAN}"' EXIT

# SIGTERM only when PID + startTicks (+ cmdline when recorded) still match.
python3 - "${PIDS_DIR}" "${SIGNALS_FILE}" "${SKIPPED_FILE}" <<'PY'
import json, os, pathlib, signal, sys

pids_dir = pathlib.Path(sys.argv[1])
signals_path = pathlib.Path(sys.argv[2])
skipped_path = pathlib.Path(sys.argv[3])
signaled = []
skipped = []

def identity(pid: int):
    stat = pathlib.Path(f"/proc/{pid}/stat")
    cmdline_p = pathlib.Path(f"/proc/{pid}/cmdline")
    if not stat.is_file():
        return None
    parts = stat.read_text().split()
    if len(parts) < 22:
        return None
    try:
        start = int(parts[21])
    except ValueError:
        return None
    cmd = ""
    if cmdline_p.is_file():
        cmd = cmdline_p.read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    return start, cmd

if pids_dir.is_dir():
    for path in sorted(pids_dir.iterdir()):
        if not path.is_file():
            continue
        raw = path.read_text().strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            skipped.append({"file": path.name, "reason": "invalid json"})
            continue
        pid = data.get("pid")
        start = data.get("startTicks")
        cmdline = data.get("cmdline") or ""
        if not isinstance(pid, int) or not isinstance(start, int):
            skipped.append({"file": path.name, "reason": "missing pid/startTicks"})
            continue
        ident = identity(pid)
        if ident is None:
            continue
        cur_start, cur_cmd = ident
        if cur_start != start:
            skipped.append({"pid": pid, "reason": "startTicks mismatch"})
            continue
        if cmdline and cur_cmd != cmdline:
            skipped.append({"pid": pid, "reason": "cmdline mismatch"})
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            signaled.append(str(pid))
        except ProcessLookupError:
            pass
        except PermissionError:
            skipped.append({"pid": pid, "reason": "permission denied"})

signals_path.write_text(json.dumps(signaled))
skipped_path.write_text(json.dumps(skipped))
PY

if [[ -f "${TMUX_FILE}" ]]; then
  while IFS= read -r session; do
    [[ -n "${session}" ]] || continue
    # Session names must include this RUN_ID so a reused name cannot be killed.
    if [[ "${session}" != *"${RUN_ID}"* ]]; then
      python3 - "${SESSIONS_FILE}" "${session}" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data.append({"session": name, "skipped": True, "reason": "name does not contain RUN_ID"})
json.dump(data, open(path, "w"))
PY
      continue
    fi
    if tmux -f /exec-daemon/tmux.portal.conf has-session -t "=${session}" 2>/dev/null; then
      tmux -f /exec-daemon/tmux.portal.conf kill-session -t "=${session}" || true
      python3 - "${SESSIONS_FILE}" "${session}" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data.append(name)
json.dump(data, open(path, "w"))
PY
    fi
  done < "${TMUX_FILE}"
fi

scratch_existed=0
if [[ -d "${SCRATCH}" ]]; then
  scratch_existed=1
  rm -rf "${SCRATCH}"
fi

python3 - "${RUN_ID}" "${SCRATCH}" "${ARTIFACTS}" "${scratch_existed}" "${SIGNALS_FILE}" "${SESSIONS_FILE}" "${SKIPPED_FILE}" <<'PY'
import json, pathlib, sys
run_id, scratch, artifacts, existed, pids_file, tmux_file, skipped_file = sys.argv[1:8]
art = pathlib.Path(artifacts)
record = art / "cleanup.json"
if record.is_file():
    sys.stdout.write(record.read_text())
    raise SystemExit(0)
if not art.is_dir() and not int(existed):
    print("cleanup: no scratch and no artifacts for this RUN_ID", file=sys.stderr)
    raise SystemExit(2)
if not art.is_dir():
    print("cleanup: artifacts dir missing — evidence was not stored", file=sys.stderr)
    raise SystemExit(1)
payload = {
  "runId": run_id,
  "scratch": scratch,
  "scratchExisted": bool(int(existed)),
  "scratchRemoved": not pathlib.Path(scratch).exists(),
  "artifacts": artifacts,
  "artifactsPreserved": art.is_dir(),
  "pidsSignaled": json.load(open(pids_file)),
  "pidsSkipped": json.load(open(skipped_file)),
  "tmuxSessionsKilled": json.load(open(tmux_file)),
  "note": "Did not delete artifacts. Did not kill processes by name. Signaled only PIDs whose /proc startTicks (and cmdline when recorded) still matched. Tmux sessions killed only when the recorded name contains this RUN_ID.",
}
record.write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
if not payload["artifactsPreserved"]:
    raise SystemExit("cleanup refused: artifacts dir missing — evidence was not stored")
PY
