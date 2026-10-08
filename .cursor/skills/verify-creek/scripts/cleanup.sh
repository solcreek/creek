#!/usr/bin/env bash
# Tear down the run directory this launch created. Does not touch artifacts/.
# Usage: cleanup.sh <run.env>
set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

if [[ "${1:-}" == "" ]]; then
  echo "usage: cleanup.sh <run.env>" >&2
  exit 2
fi
env_file="$1"
load_run_env "$env_file"

case "$VERIFY_CREEK_RUN" in
  */verify-creek-*) ;;
  *)
    echo "cleanup.sh: refusing to delete unexpected path: $VERIFY_CREEK_RUN" >&2
    exit 1
    ;;
esac
if [[ ! -d "$VERIFY_CREEK_RUN" ]]; then
  echo "verify-creek cleanup: already gone $VERIFY_CREEK_RUN" >&2
  exit 0
fi

# A local control-plane started by control-plane.sh runs from this directory:
# stop it (by the PID it recorded) before deleting its data.
cp_pid_file="$VERIFY_CREEK_RUN/control-plane/pid"
if [[ -f "$cp_pid_file" ]]; then
  kill "$(cat "$cp_pid_file")" 2>/dev/null || true
  echo "verify-creek cleanup: stopped local control-plane" >&2
fi

rm -rf "$VERIFY_CREEK_RUN"
echo "verify-creek cleanup: removed $VERIFY_CREEK_RUN" >&2
echo "verify-creek cleanup: artifacts left at $VERIFY_CREEK_ARTIFACTS" >&2
