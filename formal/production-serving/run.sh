#!/usr/bin/env bash
# Model-check ProductionServing.tla under every scenario in cfg/ and compare each
# outcome with expected.txt. Exit 0 when every outcome matches, 1 when one differs,
# 2 when the check could not run.
#
#   formal/production-serving/run.sh              # every scenario
#   formal/production-serving/run.sh rollback     # one scenario (cfg/rollback.cfg)
#
# Full TLC output, including counterexample traces, goes to $OUT
# (printed at the end); read violations with the pstack /statechart skill.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TLA_VERSION="v1.7.4"
# sha256 of tla2tools.jar from the tlaplus v1.7.4 GitHub release, recorded on
# first download (the release publishes no checksum): trust on first use.
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/creek-formal"
JAR="$CACHE/tla2tools-$TLA_VERSION.jar"
OUT="${OUT:-${TMPDIR:-/tmp}/creek-formal/production-serving-$(date +%Y%m%d-%H%M%S)}"

die() { echo "run.sh: $*" >&2; exit 2; }

# --- Java: JAVA_HOME, then a JDK unpacked under ~/.local/opt, then PATH ---
JAVA=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA="$JAVA_HOME/bin/java"
else
  for j in "$HOME"/.local/opt/jdk-*/Contents/Home/bin/java "$HOME"/.local/opt/jdk-*/bin/java; do
    [ -x "$j" ] && { JAVA="$j"; break; }
  done
  if [ -z "$JAVA" ] && command -v java >/dev/null && java -version >/dev/null 2>&1; then
    JAVA="$(command -v java)"
  fi
fi
[ -n "$JAVA" ] || die "no Java runtime (11+). Install one (e.g. Eclipse Temurin 21) or set JAVA_HOME."

# --- tla2tools.jar, pinned and verified ---
mkdir -p "$CACHE"
if [ ! -f "$JAR" ]; then
  curl -sSfL -o "$JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar" \
    || die "could not download tla2tools $TLA_VERSION"
  mv "$JAR.part" "$JAR"
fi
echo "$TLA_SHA256  $JAR" | shasum -a 256 -c - >/dev/null 2>&1 \
  || die "tla2tools.jar checksum mismatch: delete $JAR and rerun, or investigate"

# --- scenarios ---
if [ $# -gt 0 ]; then SCENARIOS=("$@"); else
  SCENARIOS=(); while read -r name _; do
    case "$name" in ''|\#*) continue ;; esac; SCENARIOS+=("$name")
  done < "$HERE/expected.txt"
fi

mkdir -p "$OUT"
status=0
printf '%-17s %-30s %-30s %s\n' scenario expected actual verdict
for name in "${SCENARIOS[@]}"; do
  cfg="$HERE/cfg/$name.cfg"
  [ -f "$cfg" ] || die "no scenario $name (cfg/$name.cfg)"
  log="$OUT/$name.log"
  (cd "$HERE" && "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
      -workers auto -metadir "$OUT/$name.states" -config "$cfg" ProductionServing.tla) >"$log" 2>&1 || true

  if grep -q "No error has been found" "$log"; then
    actual="pass"
  elif inv="$(grep -o 'Invariant [A-Za-z]* is violated' "$log" | head -1 | awk '{print $2}')" && [ -n "$inv" ]; then
    actual="violates $inv"
  else
    actual="error (see $log)"
  fi
  expected="$(awk -v n="$name" '$1==n { $1=""; sub(/^ /,""); print }' "$HERE/expected.txt")"
  if [ "$actual" = "$expected" ]; then verdict="ok"; else verdict="CHANGED"; status=1; fi
  printf '%-17s %-30s %-30s %s\n' "$name" "${expected:-(none)}" "$actual" "$verdict"
done
echo "TLC output: $OUT"
exit $status
