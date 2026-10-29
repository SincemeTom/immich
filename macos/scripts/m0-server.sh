#!/usr/bin/env bash
# Runs the Immich server natively against the M0 PostgreSQL (m0-pg.sh, port 5433), Valkey (port 6380), the
# jellyfin-ffmpeg download, and the build data from m0-build-data.sh. Media goes to a throwaway library folder.
# Usage: macos/scripts/m0-server.sh [stop]
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cache="$HOME/Library/Caches/immich-m0"
port="${M0_SERVER_PORT:-2283}"

# the server retitles its processes "immich" and "immich-api", so they are found by name, scoped to this user. Its
# exiftool-vendored children outlive it (in the container tini reaps them), so the ones from this checkout go too.
stop_server() {
  pkill -u "$(id -u)" -x immich-api 2>/dev/null || true
  pkill -u "$(id -u)" -x immich 2>/dev/null || true
  pkill -u "$(id -u)" -f "$repo/node_modules/.*exiftool -stay_open" 2>/dev/null || true
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "port $port is still in use:" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
  return 1
}

stop_server
[ "${1:-}" = stop ] && exit 0

# jellyfin-ffmpeg ahead of anything else, exactly as the container has it on PATH
export PATH="$cache/ffmpeg:/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:$PATH"
export LC_ALL=en_US.UTF-8

export NODE_ENV=production
export IMMICH_HOST=127.0.0.1
export IMMICH_PORT="$port"
export IMMICH_BUILD_DATA="$cache/build"
export IMMICH_MEDIA_LOCATION="${M0_MEDIA:-$cache/library}"
export DB_HOSTNAME=127.0.0.1
export DB_PORT=5433
export DB_USERNAME=postgres
export DB_PASSWORD=postgres
export DB_DATABASE_NAME=immich
export REDIS_HOSTNAME=127.0.0.1
export REDIS_PORT=6380
export IMMICH_LOG_LEVEL="${IMMICH_LOG_LEVEL:-log}"
mkdir -p "$IMMICH_MEDIA_LOCATION"

exec node "$repo/server/dist/main.js"
