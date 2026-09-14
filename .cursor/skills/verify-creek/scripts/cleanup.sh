#!/usr/bin/env bash
# Tear down scratch dirs / PIDs / tmux sessions THIS run created.
# Never deletes .cursor/skills/verify-creek/artifacts/.
# Never kill-all by process name.
# Usage: .cursor/skills/verify-creek/scripts/cleanup.sh [RUN_ID]

set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ensure_node_path
ensure_pnpm

if [[ -n "${1:-}" ]]; then
  RUN_ID="$1"
fi
resolve_run_for_cleanup

PIDS_DIR="${SCRATCH}/pids"
TMUX_FILE="${SCRATCH}/tmux-sessions"
SIGNALS_FILE="${ARTIFACTS}/.cleanup-pids.json"
SESSIONS_FILE="${ARTIFACTS}/.cleanup-tmux.json"
python3 -c "import json,sys; json.dump([], open(sys.argv[1],'w'))" "${SIGNALS_FILE}"
python3 -c "import json,sys; json.dump([], open(sys.argv[1],'w'))" "${SESSIONS_FILE}"

if [[ -d "${PIDS_DIR}" ]]; then
  for f in "${PIDS_DIR}"/*; do
    [[ -f "${f}" ]] || continue
    pid=""
    start_ticks=""
    if ! readarray -t pid_record < <(python3 - "${f}" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
raw = path.read_text().strip()
if not raw:
    raise SystemExit(0)
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit(0)
pid = data.get("pid")
start = data.get("startTicks")
if isinstance(pid, int) and isinstance(start, int):
    print(pid)
    print(start)
PY
); then
      continue
    fi
    [[ "${#pid_record[@]}" -eq 2 ]] || continue
    pid="${pid_record[0]}"
    start_ticks="${pid_record[1]}"
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    [[ "${start_ticks}" =~ ^[0-9]+$ ]] || continue
    if kill -0 "${pid}" 2>/dev/null; then
      current_start="$(python3 - "${pid}" <<'PY'
import pathlib, sys
stat = pathlib.Path(f"/proc/{sys.argv[1]}/stat")
if not stat.is_file():
    raise SystemExit(1)
parts = stat.read_text().split()
if len(parts) < 22:
    raise SystemExit(1)
print(parts[21])
PY
)" || continue
      if [[ "${current_start}" != "${start_ticks}" ]]; then
        continue
      fi
      kill -TERM "${pid}" 2>/dev/null || true
      python3 - "${SIGNALS_FILE}" "${pid}" <<'PY'
import json, sys
path, pid = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data.append(pid)
json.dump(data, open(path, "w"))
PY
    fi
  done
fi

if [[ -f "${TMUX_FILE}" ]]; then
  while IFS= read -r session; do
    [[ -n "${session}" ]] || continue
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

python3 - "${RUN_ID}" "${SCRATCH}" "${ARTIFACTS}" "${scratch_existed}" "${SIGNALS_FILE}" "${SESSIONS_FILE}" <<'PY'
import json, pathlib, sys
run_id, scratch, artifacts, existed, pids_file, tmux_file = sys.argv[1:7]
payload = {
  "runId": run_id,
  "scratch": scratch,
  "scratchExisted": bool(int(existed)),
  "scratchRemoved": not pathlib.Path(scratch).exists(),
  "artifacts": artifacts,
  "artifactsPreserved": pathlib.Path(artifacts).is_dir(),
  "pidsSignaled": json.load(open(pids_file)),
  "tmuxSessionsKilled": json.load(open(tmux_file)),
  "note": "Did not delete artifacts. Did not kill processes by name.",
}
pathlib.Path(artifacts, "cleanup.json").write_text(json.dumps(payload, indent=2) + "\n")
pathlib.Path(pids_file).unlink(missing_ok=True)
pathlib.Path(tmux_file).unlink(missing_ok=True)
print(json.dumps(payload, indent=2))
if not payload["artifactsPreserved"]:
    raise SystemExit("cleanup refused: artifacts dir missing — evidence was not stored")
PY
