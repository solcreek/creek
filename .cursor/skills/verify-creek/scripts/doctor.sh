#!/usr/bin/env bash
# Read-only: is this isolated CLI instance worth driving?
# Usage: doctor.sh /path/to/run.env
set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

if [[ "${1:-}" == "" ]]; then
  echo "usage: doctor.sh <run.env>" >&2
  exit 2
fi
load_run_env "$1"

fail() { echo "verify-creek doctor: FAIL: $*" >&2; exit 1; }
ok() { echo "verify-creek doctor: $*"; }

[[ -f "$VERIFY_CREEK_BIN" ]] || fail "binary missing: $VERIFY_CREEK_BIN"
[[ -f "$VERIFY_CREEK_CLI_DIST" ]] || fail "CLI dist missing: $VERIFY_CREEK_CLI_DIST (re-run launch.sh)"
[[ "$HOME" == "$VERIFY_CREEK_HOME" ]] || fail "HOME=$HOME is not the run home $VERIFY_CREEK_HOME"
[[ "$HOME" == *"/verify-creek-"* ]] || fail "HOME=$HOME is not a verify-creek run directory"
if [[ -n "${CREEK_TOKEN+x}" ]]; then
  fail "CREEK_TOKEN is set; this run would use the caller's credentials"
fi
[[ "$CREEK_API_URL" == "$VERIFY_CREEK_DEAD_API" ]] || fail "CREEK_API_URL=$CREEK_API_URL is not the dead URL $VERIFY_CREEK_DEAD_API"
[[ "$CREEK_SANDBOX_API_URL" == "$VERIFY_CREEK_DEAD_API" ]] || fail "CREEK_SANDBOX_API_URL is not the dead URL"
if [[ -f "$HOME/.creek/config.json" ]]; then
  fail "$HOME/.creek/config.json exists; this run is not a clean isolated home"
fi

want="$(expected_version)"
# Parse from a file. Command substitution can mangle the UTF-8 em dashes in
# help descriptions (locale-dependent) and JSON.parse then fails mid-schema.
help_file="$(mktemp "${TMPDIR:-/tmp}/verify-creek-help.XXXXXX")"
node "$VERIFY_CREEK_BIN" --help --json >"$help_file"
got="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String((j.command && j.command.version) || ""))' "$help_file")"
[[ "$got" == "$want" ]] || { rm -f "$help_file"; fail "version mismatch: binary=$got facade package.json=$want"; }
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (j.ok !== true) { console.error("help --json ok !== true"); process.exit(1); }
  const names = (j.command.subcommands || []).map((c) => c.name);
  for (const n of ["deploy", "init", "doctor", "whoami", "login"]) {
    if (!names.includes(n)) { console.error("missing subcommand " + n); process.exit(1); }
  }
  const deploy = (j.command.subcommands || []).find((c) => c.name === "deploy");
  if (!deploy || deploy.dryRun !== true) { console.error("deploy is not marked dryRun"); process.exit(1); }
' "$help_file"
rm -f "$help_file"

ok "bin=$VERIFY_CREEK_BIN"
ok "version=$got"
ok "HOME=$HOME"
ok "CREEK_API_URL=$CREEK_API_URL (dead; dry-run must not need it)"
ok "CREEK_TOKEN unset"
ok "ready"
