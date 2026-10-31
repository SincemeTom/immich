#!/bin/bash
# Configures and starts a native Immich install around a release folder: configuration, database cluster, LaunchAgents,
# switch-over, first-run settings and model warm-up. install.sh runs it after building a release from a checkout; the
# .pkg runs it, as the user who installs, with the self-contained release it carries.
#
# Usage: configure.sh --release DIR [options]
#   --release DIR      the release to run. One outside <home>/releases is moved there (the .pkg's)
#   --pg-prefix DIR    PostgreSQL to run (default: the release's own, for a self-contained release)
#   --home DIR         where the install is (default: ~/Library/Application Support/Immich)
#   --library DIR      where photos and videos go (default: ~/Pictures/Immich)
#   --server-port N    web UI and API (default: 2283)
#   --listen ADDR      address the server listens on (default: every interface, so phones can reach it)
#   --ml-port N        machine learning, localhost only (default: 3003)
#   --db-port N        PostgreSQL, localhost only (default: 5432)
#   --redis-port N     Valkey, localhost only (default: 6379)
#   --label PREFIX     LaunchAgent label prefix (default: local.immich), to run a second install alongside
#   --clip-model NAME  smart search model (default for a new library: XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k)
#   --no-warm          skip downloading and preparing the machine learning models
#   --no-start         configure, but leave the services stopped
#   --check-only       only check this Mac and the ports, as install.sh does before building
#   --link-dir DIR     where to put an immichctl link, for the default install (default: ~/.local/bin)
#
# Options given once are saved in <home>/config/native.env and reused; the database, settings and library are kept.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
DEFAULT_HOME="$HOME/Library/Application Support/Immich"
DEFAULT_LABEL=local.immich
# Immich's default, ViT-B-32__openai, is English only: it found 2 of 30 Chinese queries' photos first, this one 27
# (macos/verification/m1-clip-model.md)
DEFAULT_CLIP_MODEL=XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k

opt_release="" opt_pg_prefix="" opt_home="" opt_library="" opt_server_port="" opt_listen="" opt_listen_set=""
opt_ml_port="" opt_db_port="" opt_redis_port="" opt_label="" opt_clip_model="" no_warm="" no_start="" check_only=""
opt_link_dir="" fresh_database=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) opt_release="$2"; shift ;;
    --pg-prefix) opt_pg_prefix="$2"; shift ;;
    --home) opt_home="$2"; shift ;;
    --library) opt_library="$2"; shift ;;
    --server-port) opt_server_port="$2"; shift ;;
    --listen) opt_listen="$2"; opt_listen_set=1; shift ;;
    --ml-port) opt_ml_port="$2"; shift ;;
    --db-port) opt_db_port="$2"; shift ;;
    --redis-port) opt_redis_port="$2"; shift ;;
    --label) opt_label="$2"; shift ;;
    --clip-model) opt_clip_model="$2"; shift ;;
    --no-warm) no_warm=1 ;;
    --no-start) no_start=1 ;;
    --check-only) check_only=1 ;;
    --link-dir) opt_link_dir="$2"; shift ;;
    -h | --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

IMMICH_HOME="${opt_home:-$DEFAULT_HOME}"
case "$IMMICH_HOME" in /*) ;; *) echo "--home must be an absolute path" >&2; exit 64 ;; esac

# settings from an earlier install, which options override
if [ -f "$IMMICH_HOME/config/native.env" ]; then
  # shellcheck source=/dev/null
  . "$IMMICH_HOME/config/native.env"
fi
LABEL="${opt_label:-${IMMICH_NATIVE_LABEL_PREFIX:-$DEFAULT_LABEL}}"
LIBRARY="${opt_library:-${IMMICH_NATIVE_LIBRARY:-$HOME/Pictures/Immich}}"
SERVER_PORT="${opt_server_port:-${IMMICH_NATIVE_SERVER_PORT:-2283}}"
ML_PORT="${opt_ml_port:-${IMMICH_NATIVE_ML_PORT:-3003}}"
DB_PORT="${opt_db_port:-${IMMICH_NATIVE_DB_PORT:-5432}}"
REDIS_PORT="${opt_redis_port:-${IMMICH_NATIVE_REDIS_PORT:-6379}}"
LISTEN="${IMMICH_NATIVE_LISTEN:-}"
[ -n "$opt_listen_set" ] && LISTEN="$opt_listen"
DB_PASSWORD="${IMMICH_NATIVE_DB_PASSWORD:-}"
if [ "$IMMICH_HOME" = "$DEFAULT_HOME" ]; then
  LOG_DIR="${IMMICH_NATIVE_LOG_DIR:-$HOME/Library/Logs/Immich}"
else
  LOG_DIR="${IMMICH_NATIVE_LOG_DIR:-$IMMICH_HOME/logs}"
fi
case "$LIBRARY" in /*) ;; *) echo "--library must be an absolute path" >&2; exit 64 ;; esac

mkdir -p "$LOG_DIR"
INSTALL_LOG="$LOG_DIR/install.log"
# a new log, unless install.sh has started it already, or this only checks
[ -n "${IMMICH_INSTALL_LOG_STARTED:-}" ] || [ -n "$check_only" ] || : >"$INSTALL_LOG"

# --- output ------------------------------------------------------------------------------------------------------

current_step=""
step() {
  current_step="$1"
  printf '\n\033[1m==> %s\033[0m\n' "$1"
  printf '\n==> %s (%s)\n' "$1" "$(date '+%H:%M:%S')" >>"$INSTALL_LOG"
}
info() { printf '    %s\n' "$1"; printf '    %s\n' "$1" >>"$INSTALL_LOG"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; printf 'error: %s\n' "$1" >>"$INSTALL_LOG"; exit 1; }
quiet() { "$@" >>"$INSTALL_LOG" 2>&1; }
on_error() {
  local status=$?
  [ "$BASH_SUBSHELL" -gt 0 ] && exit "$status"
  printf '\n\033[31mFailed during: %s\033[0m (exit %s). The end of %s:\n\n' "$current_step" "$status" "$INSTALL_LOG" >&2
  tail -n 40 "$INSTALL_LOG" >&2
  exit "$status"
}
set -E
trap on_error ERR

# quotes a value for native.env, which bash sources
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# escapes a value for a plist
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# --- checks ------------------------------------------------------------------------------------------------------

step "Checking this Mac"
[ "$(id -u)" != 0 ] || die "run as your user, not root"
[ "$(uname -m)" = arm64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 0 ] \
  || die "this needs an Apple Silicon Mac, in a terminal not running under Rosetta"
macos="$(sw_vers -productVersion)"
[ "${macos%%.*}" -ge 14 ] || die "macOS 14 or later is needed (the CoreML build of onnxruntime), this is $macos"

# a port in use by anything but this install's own service, which runs as (or under) the LaunchAgent's process
port_owned_elsewhere() {
  local service="$1" port="$2" owner job
  owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$owner" ] || return 1
  job="$(launchctl print "gui/$(id -u)/$LABEL.$service" 2>/dev/null | awk '$1 == "pid" { print $3; exit }')"
  [ -z "$job" ] && return 0
  [ "$(ps -o pgid= -p "$owner" | tr -d ' ')" != "$(ps -o pgid= -p "$job" | tr -d ' ')" ]
}
for entry in "server:$SERVER_PORT:server-port" "ml:$ML_PORT:ml-port" "postgres:$DB_PORT:db-port" \
  "valkey:$REDIS_PORT:redis-port"; do
  IFS=: read -r service port option <<<"$entry"
  if port_owned_elsewhere "$service" "$port"; then
    owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | head -1)"
    die "port $port ($service) is in use by $(ps -o comm= -p "$owner") (pid $owner), choose another with --$option"
  fi
done
info "$(sysctl -n machdep.cpu.brand_string), macOS $macos"
[ -z "$check_only" ] || exit 0

# --- release -----------------------------------------------------------------------------------------------------

[ -n "$opt_release" ] || die "--release is needed"
[ -f "$opt_release/.complete" ] || die "$opt_release is not a complete release"
RELEASE_ID="$(sed -n 's/^id=//p' "$opt_release/RELEASE")"
STANDALONE="$(sed -n 's/^standalone=//p' "$opt_release/RELEASE")"
RELEASE="$IMMICH_HOME/releases/$RELEASE_ID"
ctl="$IMMICH_HOME/bin/immichctl"

release_macos="$(sed -n 's/^macos_min=//p' "$opt_release/RELEASE")"
if [ -n "$release_macos" ] && [ "$(printf '%s\n%s\n' "$release_macos" "$macos" | sort -V | head -1)" != "$release_macos" ]; then
  die "this release needs macOS $release_macos or later, this is $macos"
fi

step "Release $RELEASE_ID"
mkdir -p "$IMMICH_HOME/releases"
source_release="$(cd "$opt_release" && pwd -P)"
if [ "$source_release" != "$(cd "$IMMICH_HOME/releases" && pwd -P)/$RELEASE_ID" ]; then
  if [ -e "$RELEASE" ]; then
    # the same release again: what runs from it stops first
    [ -x "$ctl" ] && quiet "$ctl" stop
    rm -rf "$RELEASE"
  fi
  mv "$opt_release" "$RELEASE"
  info "moved into $RELEASE"
  # this script, and the scripts it installs, moved with it (the .pkg runs it from the release it carries)
  case "$HERE/" in "$source_release"/*) HERE="$RELEASE/${HERE#"$source_release"/}" ;; esac
fi

if [ -n "$opt_pg_prefix" ]; then
  PG_PREFIX="$opt_pg_prefix"
elif [ "$STANDALONE" = 1 ]; then
  # through `current`, so that every tool follows the release that runs
  PG_PREFIX="$IMMICH_HOME/current/postgres"
else
  die "--pg-prefix is needed for a release without its own PostgreSQL"
fi
# the PostgreSQL of the release about to run, before `current` points at it
if [ "$PG_PREFIX" = "$IMMICH_HOME/current/postgres" ]; then
  PG_BIN="$RELEASE/postgres/bin"
else
  PG_BIN="$PG_PREFIX/bin"
fi

# --- configuration -----------------------------------------------------------------------------------------------

step "Configuring $IMMICH_HOME"
mkdir -p "$IMMICH_HOME"/{bin,config,data/postgres,data/valkey,data/models} "$LIBRARY"
chmod 700 "$IMMICH_HOME/config" "$IMMICH_HOME/data/postgres"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -hex 24)"

cat >"$IMMICH_HOME/config/native.env" <<EOF
# Written by macos/native/configure.sh (from install.sh, or the .pkg), which reads it back on the next run.
# After changing a value, run the installer again to apply it everywhere it is used.
IMMICH_NATIVE_LABEL_PREFIX=$(shq "$LABEL")
IMMICH_NATIVE_LIBRARY=$(shq "$LIBRARY")
IMMICH_NATIVE_LOG_DIR=$(shq "$LOG_DIR")
# empty: every interface
IMMICH_NATIVE_LISTEN=$(shq "$LISTEN")
IMMICH_NATIVE_SERVER_PORT=$SERVER_PORT
IMMICH_NATIVE_ML_PORT=$ML_PORT
IMMICH_NATIVE_DB_PORT=$DB_PORT
IMMICH_NATIVE_REDIS_PORT=$REDIS_PORT
IMMICH_NATIVE_DB_PASSWORD=$(shq "$DB_PASSWORD")
IMMICH_NATIVE_PG_PREFIX=$(shq "$PG_PREFIX")
# 1 once the installer has turned on VideoToolbox transcoding, which it then leaves to the web UI's setting
IMMICH_NATIVE_VIDEO_ACCEL_SET=${IMMICH_NATIVE_VIDEO_ACCEL_SET:-}
EOF
chmod 600 "$IMMICH_HOME/config/native.env"

if [ ! -f "$IMMICH_HOME/config/server.env" ]; then
  cat >"$IMMICH_HOME/config/server.env" <<'EOF'
# Extra settings for the Immich server, as the environment variables in
# https://docs.immich.app/install/environment-variables, one NAME=value per line. Apply with: immichctl restart server
# Ports, paths, database and Redis settings come from native.env and win over anything set here.
#
# IMMICH_LOG_LEVEL=log
# IMMICH_TRUSTED_PROXIES=192.168.1.10
EOF
fi

cat >"$IMMICH_HOME/config/valkey.conf" <<EOF
# Written by macos/native/configure.sh
bind 127.0.0.1
port $REDIS_PORT
dir "$IMMICH_HOME/data/valkey"
logfile ""
daemonize no
EOF

install -m 755 "$HERE/run-service" "$HERE/immichctl" "$IMMICH_HOME/bin/"

pgdata="$IMMICH_HOME/data/postgres"
if [ ! -f "$pgdata/PG_VERSION" ]; then
  info "creating the database cluster"
  pwfile="$(mktemp)"
  printf '%s' "$DB_PASSWORD" >"$pwfile"
  # as the official image: data checksums, superuser postgres with a password; ICU for the same collation everywhere
  quiet "$PG_BIN/initdb" -D "$pgdata" -U postgres --pwfile="$pwfile" --auth=scram-sha-256 \
    --data-checksums --encoding=UTF8 --locale-provider=icu --icu-locale=en-US --locale=en_US.UTF-8
  rm -f "$pwfile"
  printf "\n# settings for Immich, rewritten by every install\ninclude 'immich.conf'\n" >>"$pgdata/postgresql.conf"
fi
cat >"$pgdata/immich.conf" <<EOF
# Written by macos/native/configure.sh on every run. Put your own settings in postgresql.override.conf.
listen_addresses = '127.0.0.1'
port = $DB_PORT
unix_socket_directories = ''
shared_preload_libraries = 'vchord'

# the official image's tuning, from postgresql.ssd.conf in immich-app/base-images. Its effective_io_concurrency =
# 200 is left out: macOS has no posix_fadvise(), and postgres refuses any value but 0 there.
search_path = '"\$user", public'
max_wal_size = 5GB
shared_buffers = 512MB
wal_compression = on
work_mem = 16MB
autovacuum_vacuum_scale_factor = 0.1
autovacuum_analyze_scale_factor = 0.05
autovacuum_vacuum_cost_limit = 1000
random_page_cost = 1.2

include_if_exists 'postgresql.override.conf'
EOF

step "Registering the services with launchd"
agents="$HOME/Library/LaunchAgents"
mkdir -p "$agents"
files="$(sysctl -n kern.maxfilesperproc)"
[ "$files" -gt 65536 ] && files=65536
for service in postgres valkey ml server; do
  timeout=30
  [ "$service" = postgres ] && timeout=90
  cat >"$agents/$LABEL.$service.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by macos/native/configure.sh -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml "$LABEL.$service")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$IMMICH_HOME/bin/run-service")</string>
    <string>$service</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>$timeout</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>$files</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG_DIR/$service.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG_DIR/$service.log")</string>
</dict>
</plist>
EOF
  plutil -lint -s "$agents/$LABEL.$service.plist"
done
info "$agents/$LABEL.{postgres,valkey,ml,server}.plist"

# --- switch over and start ---------------------------------------------------------------------------------------

previous="$(cd "$IMMICH_HOME/current" 2>/dev/null && pwd -P || true)"

step "Starting Immich"
quiet "$ctl" stop
ln -sfn "$RELEASE" "$IMMICH_HOME/current"
if [ -n "$no_start" ]; then
  info "--no-start: services left stopped, start them with: $ctl start"
else
  "$ctl" start postgres
  export PGPASSWORD="$DB_PASSWORD"
  if [ -z "$("$PG_BIN/psql" -h 127.0.0.1 -p "$DB_PORT" -U postgres -Atc \
    "SELECT 1 FROM pg_database WHERE datname = 'immich'")" ]; then
    quiet "$PG_BIN/psql" -h 127.0.0.1 -p "$DB_PORT" -U postgres -c "CREATE DATABASE immich"
    info "created the immich database"
    fresh_database=1
  fi
  unset PGPASSWORD
  "$ctl" start valkey
  "$ctl" start ml
  "$ctl" start server

  # Videos transcode on the GPU (macos/verification/m2-videotoolbox.md): set for a new library, and once for one from
  # before this existed. Not on later runs, which could not tell "disabled" chosen in the web UI from never set, as
  # Immich stores only what differs from its defaults.
  if [ -n "$fresh_database" ] || [ "${IMMICH_NATIVE_VIDEO_ACCEL_SET:-}" != 1 ]; then
    step "Video transcoding on the GPU (VideoToolbox)"
    "$ctl" video-accel videotoolbox | sed 's/^/    /'
    sed -i '' 's/^IMMICH_NATIVE_VIDEO_ACCEL_SET=.*/IMMICH_NATIVE_VIDEO_ACCEL_SET=1/' "$IMMICH_HOME/config/native.env"
  fi
  # the smart search model: the multilingual default for a new library, otherwise only when asked for. Changing it
  # on a library with photos means re-indexing them, which the web UI's Jobs page starts.
  if [ -n "$fresh_database" ] || [ -n "$opt_clip_model" ]; then
    step "Smart search model ${opt_clip_model:-$DEFAULT_CLIP_MODEL}"
    "$ctl" clip-model "${opt_clip_model:-$DEFAULT_CLIP_MODEL}" ${no_warm:+--no-warm} | sed 's/^/    /'
  elif [ -z "$no_warm" ]; then
    step "Preparing the machine learning models"
    "$ctl" warm | sed 's/^/    /'
  fi
fi

# keep the release that runs and the one before it, for going back
for old in "$IMMICH_HOME"/releases/*; do
  [ -d "$old" ] || continue
  old="$(cd "$old" && pwd -P)"
  if [ "$old" != "$(cd "$RELEASE" && pwd -P)" ] && [ "$old" != "$previous" ]; then
    rm -rf "$old"
  fi
done

# immichctl on the PATH for the default install
if [ "$LABEL" = "$DEFAULT_LABEL" ]; then
  link="${opt_link_dir:-$HOME/.local/bin}/immichctl"
  if mkdir -p "$(dirname "$link")" 2>/dev/null && { [ ! -e "$link" ] || [ "$(readlink "$link")" = "$ctl" ]; }; then
    ln -sfn "$ctl" "$link" 2>/dev/null && \
      case ":$(zsh -lic 'echo $PATH' 2>/dev/null):" in *":$(dirname "$link"):"*) ctl=immichctl ;; esac
  fi
fi

step "Done"
"$IMMICH_HOME/bin/immichctl" status | sed 's/^/    /'
echo
"$IMMICH_HOME/bin/immichctl" doctor | sed 's/^/    /' || true
cat <<EOF

    Open the web address above to create the admin account. From then on everything is set in the web UI.
    Manage the services with: $ctl status|start|stop|restart|logs|doctor
EOF
