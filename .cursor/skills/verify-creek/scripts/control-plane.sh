#!/usr/bin/env bash
# A disposable local control-plane for signed-in CLI proofs.
#
# Runs packages/control-plane/src/local/serve.ts (the same Hono app as the
# Worker, on SQLite + local files) under the run directory, on a free port.
# Nothing is shared with production or with another run.
#
#   control-plane.sh start   RUN_ENV           → prints the path of local.env
#   control-plane.sh signup  RUN_ENV EMAIL     → prints {"userId","orgId","orgSlug"}
#   control-plane.sh key     RUN_ENV EMAIL legacy|SCOPE[,SCOPE...] [TEAM_SLUG]  → prints the key
#   control-plane.sh sql     RUN_ENV "SQL"     → runs SQL on the local database
#   control-plane.sh stop    RUN_ENV
#
# local.env is run.env with CREEK_API_URL pointed at the local server: pass
# it to creek.sh instead of run.env for signed-in drives.
set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

cmd="${1:?usage: control-plane.sh start|signup|key|sql|stop RUN_ENV ...}"
load_run_env "${2:-}"

CP_DIR="$VERIFY_CREEK_RUN/control-plane"
CP_DB="$CP_DIR/data/creek.db"
PASSWORD="verify-creek-password"

cp_url() { cat "$CP_DIR/url"; }

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null || { echo "verify-creek: $tool is required" >&2; exit 1; }
  done
}

case "$cmd" in
start)
  need bun curl sqlite3 python3
  [[ -f "$CP_DIR/pid" ]] && kill -0 "$(cat "$CP_DIR/pid")" 2>/dev/null && {
    echo "verify-creek: control-plane already running ($(cp_url))" >&2
    echo "$VERIFY_CREEK_RUN/local.env"
    exit 0
  }
  mkdir -p "$CP_DIR/data"
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  # The server listens on 127.0.0.1 only (CREEK_LOCAL_HOSTNAME below): it
  # takes unauthenticated sign-ups. The URL still says localhost, because the
  # control-plane's origin guard trusts http://localhost:* in development and
  # nothing else over http; localhost resolves to the loopback it listens on.
  url="http://localhost:$port"
  # The server's only settings: throwaway secrets, no Cloudflare credentials,
  # and never packages/control-plane/.dev.vars (which may hold real ones).
  cat >"$CP_DIR/dev.vars" <<EOF
BETTER_AUTH_URL=$url
BETTER_AUTH_SECRET=verify-creek-$(python3 -c 'import secrets; print(secrets.token_hex(16))')
ENCRYPTION_KEY=verify-creek-$(python3 -c 'import secrets; print(secrets.token_hex(16))')
INTERNAL_SECRET=verify-creek-$(python3 -c 'import secrets; print(secrets.token_hex(16))')
EOF
  (
    cd "$VERIFY_CREEK_REPO/packages/control-plane"
    env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID \
      CREEK_LOCAL_ENV_FILE="$CP_DIR/dev.vars" CREEK_DATA_DIR="$CP_DIR/data" PORT="$port" \
      CREEK_LOCAL_HOSTNAME=127.0.0.1 \
      nohup bun run src/local/serve.ts >"$CP_DIR/server.log" 2>&1 &
    echo $! >"$CP_DIR/pid"
  )
  echo "$url" >"$CP_DIR/url"
  for _ in $(seq 1 50); do
    curl -sf "$url/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
  curl -sf "$url/health" >/dev/null || {
    echo "verify-creek: control-plane did not come up; see $CP_DIR/server.log" >&2
    exit 1
  }
  { cat "$2"; echo "export CREEK_API_URL=$(printf '%q' "$url")"; } >"$VERIFY_CREEK_RUN/local.env"
  echo "verify-creek: control-plane at $url (pid $(cat "$CP_DIR/pid"), data $CP_DIR/data)" >&2
  echo "$VERIFY_CREEK_RUN/local.env"
  ;;
signup)
  email="${3:?email}"
  url=$(cp_url)
  curl -sf -c "$CP_DIR/cookies-$email" -H 'content-type: application/json' -H "origin: $url" \
    -d "{\"name\":\"$email\",\"email\":\"$email\",\"password\":\"$PASSWORD\"}" \
    "$url/api/auth/sign-up/email" >/dev/null
  sqlite3 -json "$CP_DB" "SELECT u.id AS userId, o.id AS orgId, o.slug AS orgSlug FROM user u
    JOIN member m ON m.userId = u.id JOIN organization o ON o.id = m.organizationId
    WHERE u.email = '$email'" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]))'
  ;;
key)
  email="${3:?email}"
  scopes="${4:?legacy or a comma-separated scope list}"
  url=$(cp_url)
  # Mint through Better Auth with the user's dashboard session, exactly as
  # the dashboard does today.
  created=$(curl -sf -b "$CP_DIR/cookies-$email" -H 'content-type: application/json' -H "origin: $url" \
    -d '{"name":"verify-creek"}' "$url/api/auth/api-key/create")
  key=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
  id=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  if [[ "$scopes" != "legacy" ]]; then
    # Until the key-management route exists, store the scopes the way it will:
    # server-side, in the permissions column, pinned to the user's team.
    # Pinned to TEAM_SLUG if given, else the user's first team.
    team_slug="${5:-}"
    org=$(sqlite3 "$CP_DB" "SELECT m.organizationId FROM member m JOIN user u ON u.id = m.userId
      JOIN organization o ON o.id = m.organizationId
      WHERE u.email = '$email' AND ('$team_slug' = '' OR o.slug = '$team_slug')
      ORDER BY m.createdAt LIMIT 1")
    [[ -n "$org" ]] || { echo "verify-creek: $email is not in team '${team_slug:-<first>}'" >&2; exit 1; }
    perms=$(python3 -c 'import json,sys; s=[x for x in sys.argv[1].split(",") if x]; print(json.dumps({"creek": s, "creekTeam": [sys.argv[2]]}))' "$scopes" "$org")
    sqlite3 "$CP_DB" "UPDATE apikey SET permissions = '$perms' WHERE id = '$id'"
  fi
  echo "$key"
  ;;
sql)
  sqlite3 -json "$CP_DB" "${3:?SQL}"
  ;;
stop)
  if [[ -f "$CP_DIR/pid" ]]; then
    kill "$(cat "$CP_DIR/pid")" 2>/dev/null || true
    rm -f "$CP_DIR/pid"
    echo "verify-creek: control-plane stopped" >&2
  fi
  ;;
*)
  echo "usage: control-plane.sh start|signup|key|sql|stop RUN_ENV ..." >&2
  exit 2
  ;;
esac
