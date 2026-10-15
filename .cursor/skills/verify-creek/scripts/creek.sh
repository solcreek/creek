#!/usr/bin/env bash
# Spawn the isolated creek binary the way a user would.
# Usage: creek.sh <run.env> [--cwd DIR] [--evidence DIR] [--creek-token VALUE] -- <creek args>
#
# --creek-token sets CREEK_TOKEN (VALUE may be empty) for this one drive,
# after load_run_env has removed the caller's. Use it only to prove how the
# CLI treats CREEK_TOKEN; never pass a real key.
set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

if [[ "${1:-}" == "" ]]; then
  echo "usage: creek.sh <run.env> [--cwd DIR] [--evidence DIR] [--creek-token VALUE] -- <creek args>" >&2
  exit 2
fi
load_run_env "$1"
shift

cwd="$VERIFY_CREEK_WORK"
evidence=""
drive_token_set=0
drive_token=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --creek-token)
      [[ $# -ge 2 ]] || { echo "--creek-token requires a value (may be empty)" >&2; exit 2; }
      drive_token_set=1
      drive_token="$2"
      shift 2
      ;;
    --cwd)
      cwd="${2:?--cwd requires a directory}"
      shift 2
      ;;
    --evidence)
      evidence="${2:?--evidence requires a directory}"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "usage: creek.sh <run.env> [--cwd DIR] [--evidence DIR] [--creek-token VALUE] -- <creek args>" >&2
      exit 2
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "creek.sh: missing creek args after --" >&2
  exit 2
fi
if [[ ! -d "$cwd" ]]; then
  echo "creek.sh: cwd does not exist: $cwd" >&2
  exit 1
fi

# Exported here, not in the drive's subshell, so env.txt below records it.
if [[ "$drive_token_set" == "1" ]]; then export CREEK_TOKEN="$drive_token"; fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-creek-cmd.XXXXXX")"
# Always capture; copy into --evidence if requested. tmp is command scratch,
# not proof — cleanup of tmp happens even when evidence is kept.
set +e
(
  cd "$cwd"
  node "$VERIFY_CREEK_BIN" "$@"
) >"$tmp/stdout" 2>"$tmp/stderr"
code=$?
set -e

printf '%s' "$(printf '%q ' "$@")" >"$tmp/argv"
echo "$code" >"$tmp/exit"
{
  echo "cwd=$cwd"
  echo "HOME=$HOME"
  echo "CREEK_API_URL=${CREEK_API_URL-}"
  echo "CREEK_SANDBOX_API_URL=${CREEK_SANDBOX_API_URL-}"
  echo "CREEK_TOKEN_SET=${CREEK_TOKEN+yes}"
  echo "VERIFY_CREEK_BIN=$VERIFY_CREEK_BIN"
} >"$tmp/env.txt"

if [[ -n "$evidence" ]]; then
  mkdir -p "$evidence"
  cp "$tmp/stdout" "$tmp/stderr" "$tmp/argv" "$tmp/exit" "$tmp/env.txt" "$evidence/"
fi

cat "$tmp/stdout"
cat "$tmp/stderr" >&2
echo "exit=$code" >&2
rm -rf "$tmp"
exit "$code"
