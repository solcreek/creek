#!/usr/bin/env bash
# Self-test for creek.sh's --creek-token: the drive sees CREEK_TOKEN exactly
# as given (even empty), and env.txt records the same. Needs no build, no
# API: a stub stands in for the CLI binary.
# Usage: .cursor/skills/verify-creek/scripts/test-creek-sh.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-creek-selftest.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/work"
# The stub prints whether CREEK_TOKEN is set and its value.
cat >"$tmp/stub.js" <<'EOF'
const t = process.env.CREEK_TOKEN;
process.stdout.write(t === undefined ? "unset\n" : `set:${t}\n`);
EOF
cat >"$tmp/run.env" <<EOF
unset CREEK_TOKEN
export VERIFY_CREEK_RUN=$(printf '%q' "$tmp")
export VERIFY_CREEK_HOME=$(printf '%q' "$tmp/home")
export VERIFY_CREEK_WORK=$(printf '%q' "$tmp/work")
export VERIFY_CREEK_BIN=$(printf '%q' "$tmp/stub.js")
export HOME=$(printf '%q' "$tmp/home")
export CREEK_API_URL=http://127.0.0.1:1
export CREEK_SANDBOX_API_URL=http://127.0.0.1:1
EOF

fail=0
check() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fail=1; fi
}
drive() { # evidence-dir creek.sh-args...
  local ev="$1"
  shift
  CREEK_TOKEN=caller-value "$here/creek.sh" "$tmp/run.env" --evidence "$ev" "$@" -- whoami 2>/dev/null
}

check "a caller's CREEK_TOKEN never reaches the drive" "unset" "$(drive "$tmp/ev-none")"
check "env.txt: unset" "CREEK_TOKEN_SET=" "$(grep '^CREEK_TOKEN_SET=' "$tmp/ev-none/env.txt")"

check "--creek-token VALUE reaches the drive" "set:k1" "$(drive "$tmp/ev-set" --creek-token k1)"
check "env.txt: set" "CREEK_TOKEN_SET=yes" "$(grep '^CREEK_TOKEN_SET=' "$tmp/ev-set/env.txt")"

check "--creek-token '' reaches the drive empty" "set:" "$(drive "$tmp/ev-empty" --creek-token "")"
check "env.txt: set (empty)" "CREEK_TOKEN_SET=yes" "$(grep '^CREEK_TOKEN_SET=' "$tmp/ev-empty/env.txt")"

exit "$fail"
