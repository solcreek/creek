# Shared by launch/doctor/creek/cleanup. Source, do not execute.
# Locates the creek monorepo from this skill's scripts/ directory.

_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_CREEK_SKILL_DIR="$(cd "$_scripts_dir/.." && pwd)"
VERIFY_CREEK_ARTIFACTS="$VERIFY_CREEK_SKILL_DIR/artifacts"

_find_repo_root() {
  local d="$VERIFY_CREEK_SKILL_DIR"
  while [[ "$d" != "/" ]]; do
    if [[ -f "$d/pnpm-workspace.yaml" && -d "$d/packages/cli" && -d "$d/packages/creek" ]]; then
      printf '%s\n' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  echo "verify-creek: could not find repo root (pnpm-workspace.yaml + packages/cli) above $VERIFY_CREEK_SKILL_DIR" >&2
  return 1
}

VERIFY_CREEK_REPO="$(_find_repo_root)"
VERIFY_CREEK_BIN_DEFAULT="$VERIFY_CREEK_REPO/packages/creek/bin.js"
VERIFY_CREEK_CLI_DIST="$VERIFY_CREEK_REPO/packages/cli/dist/index.js"
VERIFY_CREEK_FACADE_PKG="$VERIFY_CREEK_REPO/packages/creek/package.json"

# Closed local port. Dry-run / init / doctor / unauthenticated whoami must
# succeed even when every Creek API URL would connection-refuse.
VERIFY_CREEK_DEAD_API="http://127.0.0.1:1"

load_run_env() {
  local env_file="${1:-}"
  if [[ -z "$env_file" || ! -f "$env_file" ]]; then
    echo "verify-creek: run.env not found: ${env_file:-<missing>}" >&2
    echo "Run .cursor/skills/verify-creek/scripts/launch.sh first." >&2
    return 1
  fi
  # Isolate from the caller's Creek session. An empty CREEK_TOKEN stays set:
  # ?? does not fall through to ~/.creek/config.json, and auth checks treat
  # that empty string as signed out without calling the API.
  unset CREEK_TOKEN CREEK_API_URL CREEK_SANDBOX_API_URL CREEK_HOSTS_PATH
  # shellcheck disable=SC1090
  source "$env_file"
  if [[ -z "${VERIFY_CREEK_RUN:-}" || -z "${HOME:-}" || -z "${VERIFY_CREEK_BIN:-}" ]]; then
    echo "verify-creek: $env_file is missing VERIFY_CREEK_RUN, HOME, or VERIFY_CREEK_BIN" >&2
    return 1
  fi
}

expected_version() {
  node -e "const p=require(process.argv[1]); process.stdout.write(String(p.version))" "$VERIFY_CREEK_FACADE_PKG"
}
