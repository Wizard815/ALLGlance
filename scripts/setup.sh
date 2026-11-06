#!/usr/bin/env bash
# One-command setup for the AllGLANCE stack.
#
#   scripts/setup.sh
#
# Safe to re-run: it keeps every value already in .env.allglance and only fills
# in what is missing. It:
#   1. writes .env.allglance with generated secrets (you choose the sync passphrase),
#   2. creates the data directories (owned 99:100 on Unraid, i.e. nobody:users),
#   3. starts Vikunja, creates its user and an API token with MCP access,
#   4. builds and starts everything, and waits until the gateway is healthy,
#   5. prints the three things you need next: the MCP URL + token, the sync
#      settings to type into each GLANCE app, and the Vikunja login.
#
# Optional environment:
#   GLANCE_SYNC_PASSPHRASE  skip the prompt (non-interactive use)
#   ALLGLANCE_DATA          where data lives (default /mnt/user/appdata/allglance-data)
#   COMPOSE_FILE            e.g. docker-compose.yml:docker/compose.proxy-ca.yml (behind a
#                           TLS-intercepting proxy; see README)
#   VIKUNJA_USER            Vikunja username to create (default: household)

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.allglance
dc() { docker compose --env-file "$ENV_FILE" "$@"; }
say() { printf '\n==> %s\n' "$*"; }
# Random hex of length N (<=256). No early-closed pipe, so it is safe under pipefail.
rand() { head -c 128 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-"${1:-32}"; }
get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
set_kv() { # set_kv KEY VALUE  (replace in place, or append)
  if grep -qE "^$1=" "$ENV_FILE"; then
    local tmp; tmp=$(mktemp); awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" >"$tmp" && cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}
fill() { # fill KEY VALUE  — only if unset/empty
  [[ -n "$(get "$1")" ]] || set_kv "$1" "$2"
}

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose (v2) is required" >&2; exit 1; }

# --- 1. environment file -----------------------------------------------------
say "Environment"
[[ -f "$ENV_FILE" ]] || { cp gateway/.env.example "$ENV_FILE"; chmod 600 "$ENV_FILE"; echo "created $ENV_FILE"; }
fill VIKUNJA_SERVICE_SECRET "$(rand 48)"
fill DAYGLANCE_SYNC_PASSWORD "$(rand 24)"
fill DAYGLANCE_MCP_TOKEN "$(rand 40)"
fill GATEWAY_TOKEN "$(rand 40)"
fill GLANCEVAULT_DEVICE_TOKEN "$(rand 40)"
[[ -n "${ALLGLANCE_DATA:-}" ]] && set_kv ALLGLANCE_DATA "$ALLGLANCE_DATA"
fill ALLGLANCE_DATA /mnt/user/appdata/allglance-data

if [[ -z "$(get GLANCE_SYNC_PASSPHRASE)" ]]; then
  if [[ -n "${GLANCE_SYNC_PASSPHRASE:-}" ]]; then
    set_kv GLANCE_SYNC_PASSPHRASE "$GLANCE_SYNC_PASSPHRASE"
  elif [[ -t 0 ]]; then
    echo "Choose your household sync passphrase. You type the SAME one into dayGLANCE,"
    echo "lastGLANCE and lifeGLANCE (Cloud Sync -> encryption). Store it in a password manager."
    read -r -s -p "Sync passphrase: " p1; echo; read -r -s -p "Again: " p2; echo
    [[ -n "$p1" && "$p1" == "$p2" ]] || { echo "passphrases empty or different" >&2; exit 1; }
    set_kv GLANCE_SYNC_PASSPHRASE "$p1"
  else
    set_kv GLANCE_SYNC_PASSPHRASE "$(rand 24)"; echo "no terminal: generated a sync passphrase (it is in $ENV_FILE)"
  fi
fi

# --- 2. data directories -----------------------------------------------------
say "Data directories"
DATA=$(get ALLGLANCE_DATA)
mkdir -p "$DATA"/{vikunja/{db,files,logs},dayglance-sync,gateway,glance-vault}
if [[ $EUID -eq 0 ]]; then chown -R 99:100 "$DATA"; else echo "(not root: leaving ownership as is; the containers run as 99:100)"; fi
echo "$DATA"

# --- 3. vikunja user + token ---------------------------------------------------
if [[ -z "$(get VIKUNJA_TOKEN)" ]]; then
  say "Starting Vikunja"
  dc up -d vikunja
  for _ in $(seq 1 60); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' allglance-vikunja 2>/dev/null)" == healthy ]] && break; sleep 2
  done
  [[ "$(docker inspect -f '{{.State.Health.Status}}' allglance-vikunja)" == healthy ]] || { echo "Vikunja did not become healthy; see: docker logs allglance-vikunja" >&2; exit 1; }

  VUSER=${VIKUNJA_USER:-household}; VPASS=$(rand 20)
  say "Creating Vikunja user '$VUSER'"
  docker exec allglance-vikunja /app/vikunja/vikunja user create -u "$VUSER" -e "$VUSER@allglance.local" -p "$VPASS" >/dev/null
  PORT=$(docker port allglance-vikunja 3456/tcp | head -1 | sed 's/.*://')
  JWT=$(curl -fsS -X POST "http://localhost:$PORT/api/v2/login" -H 'content-type: application/json' \
        -d "{\"username\":\"$VUSER\",\"password\":\"$VPASS\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')
  EXPIRES=$(date -u -d '+5 years' +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -v+5y +%Y-%m-%dT00:00:00Z)
  TOKEN=$(curl -fsS -X POST "http://localhost:$PORT/api/v2/tokens" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
        -d "{\"title\":\"allglance\",\"expires_at\":\"$EXPIRES\",\"permissions\":{\"mcp\":[\"access\"],\"projects\":[\"read_all\",\"read_one\",\"users_search\"],\"tasks\":[\"read_all\",\"read_one\",\"create\",\"update\"],\"tasks_assignees\":[\"create\",\"read_all\"]}}" \
        | sed -E 's/.*"token":"(tk_[^"]+)".*/\1/')
  [[ "$TOKEN" == tk_* ]] || { echo "could not create the Vikunja API token" >&2; exit 1; }
  set_kv VIKUNJA_TOKEN "$TOKEN"
  set_kv VIKUNJA_BOOTSTRAP_USER "$VUSER"
  set_kv VIKUNJA_BOOTSTRAP_PASSWORD "$VPASS"
fi

# --- 4. everything -----------------------------------------------------------------
say "Building and starting the stack (the first build takes a few minutes)"
dc up -d --build

say "Waiting for the gateway"
GPORT=8090
for _ in $(seq 1 60); do curl -fsS "http://localhost:$GPORT/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "http://localhost:$GPORT/health" >/dev/null || { echo "gateway not healthy; see: docker logs allglance" >&2; exit 1; }

# --- 5. what to do next --------------------------------------------------------------
HOST=$(hostname -I 2>/dev/null | awk '{print $1}'); HOST=${HOST:-localhost}
cat <<EOF

AllGLANCE is running.

 1. Connect your agent (Claude, Home Assistant, ...) to ONE endpoint:
      MCP URL   http://$HOST:8090/mcp
      REST      http://$HOST:8090/api/allglance/...
      Header    Authorization: Bearer $(get GATEWAY_TOKEN)

 2. In each GLANCE app (one time per device), Cloud Sync -> WebDAV:
      URL       http://$HOST:8091          (web builds in this stack: http://allglance:6065)
      User      $(get DAYGLANCE_SYNC_USER)
      Password  $(get DAYGLANCE_SYNC_PASSWORD)
      Encrypt   on, with your sync passphrase
      Folder    dayGLANCE: dayglance   (lastGLANCE / lifeGLANCE: keep their defaults)
    Chore handoff (lastGLANCE -> dayGLANCE) is the apps' "Integration" setting: same URL and
    login, events folder GLANCE/events.

 3. Open the apps:  dayGLANCE :6767   lastGLANCE :3000   lifeGLANCE :6868   Vikunja :3457
      Vikunja login  $(get VIKUNJA_BOOTSTRAP_USER) / $(get VIKUNJA_BOOTSTRAP_PASSWORD)
      CalDAV (tasks) http://$HOST:8090/dav/  with that login (the gateway serves it; Home
                     Assistant, phones and calendar apps all point here)

Secrets are in $ENV_FILE (mode 600, never committed).
EOF
