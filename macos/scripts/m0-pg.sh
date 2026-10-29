#!/usr/bin/env bash
# M0: a throwaway PostgreSQL 17 cluster with VectorChord preloaded, separate from any brew service.
# Usage: macos/scripts/m0-pg.sh init|start|stop|status|psql [args]
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
# with LANG unset (as under launchd or an IDE), postgres asks macOS for the locale, which starts a thread in the postmaster
# and it refuses to run: "postmaster became multithreaded during startup"
export LC_ALL="${M0_PG_LOCALE:-en_US.UTF-8}"
data="${M0_PG_DATA:-$HOME/Library/Caches/immich-m0/pgdata}"
port="${M0_PG_PORT:-5433}"
log="${M0_PG_LOG:-/tmp/immich-m0/postgres.log}"
mkdir -p "$(dirname "$log")"

case "${1:-}" in
  init)
    [ -d "$data" ] && { echo "$data exists"; exit 1; }
    # same initdb arguments and credentials as docker/docker-compose.yml with the example .env
    initdb -D "$data" -U postgres --auth=trust --data-checksums --encoding=UTF8 --locale=C >/dev/null
    cat >>"$data/postgresql.conf" <<EOF
port = $port
listen_addresses = '127.0.0.1'
unix_socket_directories = '/tmp'
shared_preload_libraries = 'vchord'
EOF
    echo "initialised $data on port $port"
    ;;
  start) pg_ctl -D "$data" -l "$log" -w start ;;
  stop) pg_ctl -D "$data" -m fast -w stop ;;
  status) pg_ctl -D "$data" status ;;
  psql) shift; psql -h 127.0.0.1 -p "$port" -U postgres "$@" ;;
  *) echo "usage: $0 init|start|stop|status|psql [args]" >&2; exit 1 ;;
esac
