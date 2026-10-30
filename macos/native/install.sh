#!/bin/bash
# Installs or upgrades Immich natively on an Apple Silicon Mac from this checkout, with no Docker: PostgreSQL 17
# with VectorChord, Valkey, the machine learning service on CoreML, and the server, each run by a LaunchAgent.
#
# Usage: macos/native/install.sh [options]
#   --home DIR         where to install (default: ~/Library/Application Support/Immich)
#   --library DIR      where photos and videos go (default: ~/Pictures/Immich)
#   --server-port N    web UI and API (default: 2283)
#   --listen ADDR      address the server listens on (default: every interface, so phones can reach it)
#   --ml-port N        machine learning, localhost only (default: 3003)
#   --db-port N        PostgreSQL, localhost only (default: 5432)
#   --redis-port N     Valkey, localhost only (default: 6379)
#   --label PREFIX     LaunchAgent label prefix (default: local.immich), to run a second install alongside
#   --clip-model NAME  smart search model (default for a new library: XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k,
#                      which understands Chinese as well as English); on an existing library, switches to NAME
#   --no-warm          skip downloading and preparing the machine learning models (they are then fetched on first use)
#   --no-start         build and configure, but leave the services stopped
#   -h, --help
#
# Running it again upgrades: it builds a new release next to the running one, then switches to it. Options given
# once are saved in <home>/config/native.env and reused; the database, settings and library are kept.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_HOME="$HOME/Library/Application Support/Immich"
DEFAULT_LABEL=local.immich
# Immich's default, ViT-B-32__openai, is English only: it found 2 of 30 Chinese queries' photos first, this one 27
# (macos/verification/m1-clip-model.md). It downloads 4.8 GB, takes about 14 GB on disk with CoreML's compiled copy,
# and about 7 GB of memory while loaded.
DEFAULT_CLIP_MODEL=XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k
BREW=/opt/homebrew/bin/brew
PG_FORMULA=postgresql@17
PG_PREFIX=/opt/homebrew/opt/$PG_FORMULA
# the mise.toml tools the build has no use for (Java is for the mobile app's API client)
MISE_UNUSED="java,terragrunt,opentofu,npm:@openapitools/openapi-generator-cli,npm:oazapfts,github:extism/cli"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }

# --- options -----------------------------------------------------------------------------------------------------

opt_home="" opt_library="" opt_server_port="" opt_listen="" opt_listen_set="" opt_ml_port="" opt_db_port=""
opt_redis_port="" opt_label="" opt_clip_model="" no_warm="" no_start="" fresh_database=""
while [ $# -gt 0 ]; do
  case "$1" in
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
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
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
: >"$INSTALL_LOG"

# --- output ------------------------------------------------------------------------------------------------------

current_step=""
step() {
  current_step="$1"
  printf '\n\033[1m==> %s\033[0m\n' "$1"
  printf '\n==> %s (%s)\n' "$1" "$(date '+%H:%M:%S')" >>"$INSTALL_LOG"
}
info() { printf '    %s\n' "$1"; printf '    %s\n' "$1" >>"$INSTALL_LOG"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
# runs a command with its output going to the install log only
quiet() { "$@" >>"$INSTALL_LOG" 2>&1; }
# once and verbosely, from the shell the failure reached first (subshells pass it up through their exit status)
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
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 HOMEBREW_NO_ENV_HINTS=1
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export MISE_TRUSTED_CONFIG_PATHS="$REPO/mise.toml" MISE_YES=1 MISE_DISABLE_TOOLS="$MISE_UNUSED"
# uv-managed CPython only: an Intel Python under /usr/local would install x86 wheels without CoreML
export UV_PYTHON_PREFERENCE=only-managed

mise_exec() { (cd "$REPO" && mise exec -- "$@"); }

# --- 1. checks ---------------------------------------------------------------------------------------------------

step "Checking this Mac"
[ "$(id -u)" != 0 ] || die "run as your user, not root"
[ "$(uname -m)" = arm64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 0 ] \
  || die "this needs an Apple Silicon Mac, in a terminal not running under Rosetta"
macos="$(sw_vers -productVersion)"
[ "${macos%%.*}" -ge 14 ] || die "macOS 14 or later is needed (the CoreML build of onnxruntime), this is $macos"
[ -x "$BREW" ] || die "Homebrew for Apple Silicon is missing at /opt/homebrew, install it from https://brew.sh"
# Homebrew's clang, which builds VectorChord, finds no headers unless the SDK is spelled out for it, unlike /usr/bin/clang
SDKROOT="$(xcrun --show-sdk-path 2>/dev/null)" && [ -d "$SDKROOT" ] \
  || die "no macOS SDK: install the Xcode command line tools with xcode-select --install"
export SDKROOT
free_gb="$(df -g "$HOME" | awk 'NR == 2 { print $4 }')"
# the build, and the models with their CoreML copies (about 14 GB for the default smart search model)
need_gb=15
[ -d "$IMMICH_HOME/data/models" ] || need_gb=35
[ "$free_gb" -ge "$need_gb" ] || die "at least $need_gb GB free is needed, there are $free_gb GB"
info "$(sysctl -n machdep.cpu.brand_string), macOS $macos, $free_gb GB free"

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

# --- 2. tools ----------------------------------------------------------------------------------------------------

step "Installing tools with Homebrew"
formulae=("$PG_FORMULA" pgvector valkey vips gzip llvm@18 rustup pkg-config mise uv)
missing=()
for formula in "${formulae[@]}"; do
  "$BREW" list --versions "$formula" >/dev/null 2>&1 || missing+=("$formula")
done
if [ ${#missing[@]} -gt 0 ]; then
  info "installing ${missing[*]}"
  quiet "$BREW" install "${missing[@]}"
fi
info "PostgreSQL $("$PG_PREFIX/bin/postgres" --version | awk '{ print $3 }'), libvips $(vips --version | sed 's/vips-//'), $(valkey-server --version | awk '{ print $3 }')"

step "Installing the versions mise.lock pins (Node, pnpm, jellyfin-ffmpeg, plugin toolchain)"
quiet bash -c "cd '$REPO' && mise install --locked"
info "Node $(mise_exec node -v), pnpm $(mise_exec pnpm -v), jellyfin-ffmpeg $(basename "$(dirname "$(mise_exec which ffmpeg)")")"

# --- 3. VectorChord ----------------------------------------------------------------------------------------------

# the version the official database image runs, e.g. ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
VCHORD_VERSION="$(sed -n 's/.*immich-app\/postgres:[0-9]*-vectorchord\([0-9.]*\)-.*/\1/p' "$REPO/docker/docker-compose.yml" | head -1)"
[ -n "$VCHORD_VERSION" ] || die "cannot read the VectorChord version from docker/docker-compose.yml"
step "VectorChord $VCHORD_VERSION for PostgreSQL 17"
control="$("$PG_PREFIX/bin/pg_config" --sharedir)/extension/vchord.control"
installed="$(sed -n "s/^default_version = '\(.*\)'/\1/p" "$control" 2>/dev/null || true)"
if [ "$installed" = "$VCHORD_VERSION" ] && [ -f "$("$PG_PREFIX/bin/pg_config" --pkglibdir)/vchord.dylib" ]; then
  info "already installed"
else
  src="$IMMICH_HOME/cache/src/vectorchord-$VCHORD_VERSION"
  if [ ! -d "$src" ]; then
    mkdir -p "$(dirname "$src")"
    quiet git clone --depth 1 --branch "$VCHORD_VERSION" https://github.com/tensorchord/VectorChord.git "$src"
  fi
  toolchain="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$src/rust-toolchain.toml")"
  info "building with Rust $toolchain (a few minutes the first time)"
  quiet rustup toolchain install "$toolchain" --profile minimal
  command -v cargo-make >/dev/null 2>&1 || quiet cargo install cargo-make --locked
  # pgrx hands clang the flags Homebrew built PostgreSQL with, verbatim, and those name an -isysroot under the command
  # line tools. Builds find no headers at all when that SDK is not the one in use, as on a Mac with Xcode but without
  # the command line tools installed, so build through a pg_config that names the SDK this Mac actually has.
  # It has to sit at a path without spaces: VectorChord's Makefile expands $(PG_CONFIG) unquoted, and a path through
  # "Application Support" is then split in two, which leaves make installing into nowhere.
  pg_config_dir="$(mktemp -d "${TMPDIR:-/tmp}/immich-pgconfig.XXXXXX")"
  pg_config="$pg_config_dir/pg_config"
  cat >"$pg_config" <<EOF
#!/bin/bash
exec "$PG_PREFIX/bin/pg_config" "\$@" | sed "s|-isysroot [^ ]*|-isysroot $SDKROOT|g"
EOF
  chmod +x "$pg_config"
  # the recipe of VectorChord's own macOS CI job (psql_macos in .github/workflows/check.yml)
  (
    cd "$src"
    export CC="/opt/homebrew/opt/llvm@18/bin/clang" PGRX_PG_CONFIG_PATH="$pg_config"
    quiet cargo make build -o ./build/raw
    quiet make PG_CONFIG="$pg_config" install
  )
  rm -rf "$pg_config_dir"
  info "installed into $("$PG_PREFIX/bin/pg_config" --pkglibdir)"
fi

# --- 4. release --------------------------------------------------------------------------------------------------

VERSION="$(sed -n 's/^  "version": "\(.*\)",/\1/p' "$REPO/server/package.json" | head -1)"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
RELEASE_ID="$VERSION-$COMMIT"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  RELEASE_ID="$RELEASE_ID-dirty-$(date +%Y%m%d%H%M%S)"
fi
RELEASE="$IMMICH_HOME/releases/$RELEASE_ID"

step "Release $RELEASE_ID"
if [ -f "$RELEASE/.complete" ]; then
  info "already built"
else
  rm -rf "$RELEASE"
  mkdir -p "$RELEASE"/{node/bin,ffmpeg,ml,build/plugins/immich-plugin-core}

  info "installing JavaScript dependencies"
  quiet mise_exec pnpm --filter immich --filter immich-web --filter @immich/sdk --filter @immich/plugin-sdk \
    --filter @immich/plugin-core install --frozen-lockfile

  info "building the SDKs, server, web UI and core plugin"
  quiet mise_exec pnpm --filter @immich/sdk --filter @immich/plugin-sdk build
  quiet mise_exec pnpm --filter immich build
  quiet mise_exec pnpm --filter immich-web build
  quiet mise_exec pnpm --filter @immich/plugin-core build

  info "assembling the server, as server/Dockerfile does"
  quiet mise_exec pnpm --filter immich --prod --no-optional deploy "$RELEASE/server"
  # sharp's prebuilt libvips reads no JPEG XL or camera RAW; built against Homebrew's, it reads both
  quiet mise_exec env SHARP_FORCE_GLOBAL_LIBVIPS=true pnpm --config.verify-deps-before-run=false \
    --dir "$RELEASE/server/node_modules/sharp" exec npm run build
  cp "$(mise_exec which node)" "$RELEASE/node/bin/node"
  formats="$(cd "$RELEASE/server" && "$RELEASE/node/bin/node" -e \
    "const s=require('sharp');console.log(Object.keys(s.format).filter(k=>s.format[k].input.file).join(' '))")"
  for format in heif jxl dcraw; do
    case " $formats " in *" $format "*) ;; *) die "sharp cannot read $format (it reads: $formats)" ;; esac
  done
  info "sharp reads: $formats"

  cp -R "$REPO/web/build" "$RELEASE/build/www"
  cp -R "$REPO/packages/plugin-core/dist" "$REPO/packages/plugin-core/manifest.json" \
    "$RELEASE/build/plugins/immich-plugin-core/"
  ffmpeg_dir="$(dirname "$(mise_exec which ffmpeg)")"
  cp "$ffmpeg_dir/ffmpeg" "$ffmpeg_dir/ffprobe" "$RELEASE/ffmpeg/"

  info "installing the machine learning service"
  (
    cd "$REPO/machine-learning"
    export UV_PROJECT_ENVIRONMENT="$RELEASE/ml/venv"
    quiet uv sync --frozen --extra cpu --no-dev --no-install-project --python 3.12 --no-progress
  )
  rsync -a --exclude __pycache__ "$REPO/machine-learning/immich_ml" "$RELEASE/ml/"
  providers="$("$RELEASE/ml/venv/bin/python" -c 'import onnxruntime as o; print(" ".join(o.get_available_providers()))')"
  case " $providers " in *" CoreMLExecutionProvider "*) ;; *) die "onnxruntime has no CoreML provider ($providers)" ;; esac
  info "onnxruntime providers: $providers"

  cat >"$RELEASE/RELEASE" <<EOF
id=$RELEASE_ID
version=$VERSION
commit=$(git -C "$REPO" rev-parse HEAD)
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node=$("$RELEASE/node/bin/node" -v)
vectorchord=$VCHORD_VERSION
EOF
  touch "$RELEASE/.complete"
fi

# geodata, shared by releases: what immich-app/base-images server/Dockerfile downloads into the image
geodata="$IMMICH_HOME/shared/geodata"
if [ ! -s "$geodata/geodata-date.txt" ]; then
  info "downloading geodata for reverse geocoding"
  mkdir -p "$geodata"
  (
    cd "$geodata"
    quiet curl -fsSLO https://download.geonames.org/export/dump/cities500.zip
    for file in admin1CodesASCII.txt admin2Codes.txt countryInfo.txt; do
      quiet curl -fsSLO "https://download.geonames.org/export/dump/$file"
    done
    quiet curl -fsSLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson
    quiet unzip -oq cities500.zip
    rm cities500.zip
    date -u +%Y-%m-%dT%H:%M:%S+00:00 | tr -d '\n' >geodata-date.txt
  )
fi
ln -sfn "$geodata" "$RELEASE/build/geodata"

# --- 5. configuration --------------------------------------------------------------------------------------------

step "Configuring $IMMICH_HOME"
mkdir -p "$IMMICH_HOME"/{bin,config,data/postgres,data/valkey,data/models} "$LIBRARY"
chmod 700 "$IMMICH_HOME/config" "$IMMICH_HOME/data/postgres"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -hex 24)"

cat >"$IMMICH_HOME/config/native.env" <<EOF
# Written by macos/native/install.sh, which reads it back on the next run.
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
# Written by macos/native/install.sh
bind 127.0.0.1
port $REDIS_PORT
dir "$IMMICH_HOME/data/valkey"
logfile ""
daemonize no
EOF

install -m 755 "$REPO/macos/native/run-service" "$REPO/macos/native/immichctl" "$IMMICH_HOME/bin/"

pgdata="$IMMICH_HOME/data/postgres"
if [ ! -f "$pgdata/PG_VERSION" ]; then
  info "creating the database cluster"
  pwfile="$(mktemp)"
  printf '%s' "$DB_PASSWORD" >"$pwfile"
  # as the official image: data checksums, superuser postgres with a password; ICU for the same collation everywhere
  quiet "$PG_PREFIX/bin/initdb" -D "$pgdata" -U postgres --pwfile="$pwfile" --auth=scram-sha-256 \
    --data-checksums --encoding=UTF8 --locale-provider=icu --icu-locale=en-US --locale=en_US.UTF-8
  rm -f "$pwfile"
  printf "\n# settings for Immich, rewritten by every install\ninclude 'immich.conf'\n" >>"$pgdata/postgresql.conf"
fi
cat >"$pgdata/immich.conf" <<EOF
# Written by macos/native/install.sh on every run. Put your own settings in postgresql.override.conf.
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
<!-- Written by macos/native/install.sh -->
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

# --- 6. switch over and start ------------------------------------------------------------------------------------

ctl="$IMMICH_HOME/bin/immichctl"
previous="$(cd "$IMMICH_HOME/current" 2>/dev/null && pwd -P || true)"

step "Starting Immich"
quiet "$ctl" stop
ln -sfn "$RELEASE" "$IMMICH_HOME/current"
if [ -n "$no_start" ]; then
  info "--no-start: services left stopped, start them with: $ctl start"
else
  "$ctl" start postgres
  export PGPASSWORD="$DB_PASSWORD"
  if [ -z "$("$PG_PREFIX/bin/psql" -h 127.0.0.1 -p "$DB_PORT" -U postgres -Atc \
    "SELECT 1 FROM pg_database WHERE datname = 'immich'")" ]; then
    quiet "$PG_PREFIX/bin/psql" -h 127.0.0.1 -p "$DB_PORT" -U postgres -c "CREATE DATABASE immich"
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

# immichctl on the PATH for the default install, in ~/.local/bin (uv's, already on the PATH) rather than in Homebrew's
if [ "$LABEL" = "$DEFAULT_LABEL" ]; then
  link="$HOME/.local/bin/immichctl"
  mkdir -p "$(dirname "$link")"
  if [ ! -e "$link" ] || [ "$(readlink "$link")" = "$ctl" ]; then
    ln -sfn "$ctl" "$link"
    case ":$(zsh -lic 'echo $PATH' 2>/dev/null):" in *":$HOME/.local/bin:"*) ctl=immichctl ;; esac
  fi
fi

step "Done"
"$IMMICH_HOME/bin/immichctl" status | sed 's/^/    /'
echo
"$IMMICH_HOME/bin/immichctl" doctor | sed 's/^/    /'
cat <<EOF

    Open the web address above to create the admin account. From then on everything is set in the web UI.
    Manage the services with: $ctl status|start|stop|restart|logs|doctor
EOF
