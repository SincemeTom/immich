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
# once are saved in <home>/config/native.env and reused; the database, settings and library are kept. Configuring and
# starting is configure.sh's, which the .pkg (macos/package) runs too.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_HOME="$HOME/Library/Application Support/Immich"
BREW=/opt/homebrew/bin/brew
PG_FORMULA=postgresql@17
PG_PREFIX=/opt/homebrew/opt/$PG_FORMULA
# the mise.toml tools the build has no use for (Java is for the mobile app's API client)
MISE_UNUSED="java,terragrunt,opentofu,npm:@openapitools/openapi-generator-cli,npm:oazapfts,github:extism/cli"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }

# --- options: configure.sh takes them all; this needs a few to build -----------------------------------------------

ARGS=("$@")
opt_home="" no_warm=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) opt_home="$2"; shift ;;
    --library | --server-port | --listen | --ml-port | --db-port | --redis-port | --label | --clip-model) shift ;;
    --no-warm) no_warm=1 ;;
    --no-start) ;;
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
if [ "$IMMICH_HOME" = "$DEFAULT_HOME" ]; then
  LOG_DIR="${IMMICH_NATIVE_LOG_DIR:-$HOME/Library/Logs/Immich}"
else
  LOG_DIR="${IMMICH_NATIVE_LOG_DIR:-$IMMICH_HOME/logs}"
fi

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
# the build, and the models with their CoreML copies (about 14 GB for the default smart search model), unless they
# are already there or left for later
need_gb=15
[ -d "$IMMICH_HOME/data/models" ] || [ -n "$no_warm" ] || need_gb=35
[ "$free_gb" -ge "$need_gb" ] || die "at least $need_gb GB free is needed, there are $free_gb GB"
info "$(sysctl -n machdep.cpu.brand_string), macOS $macos, $free_gb GB free"

# the ports, and the Mac itself, as configure.sh checks them before it starts anything
IMMICH_INSTALL_LOG_STARTED=1 "$REPO/macos/native/configure.sh" --check-only ${ARGS[@]+"${ARGS[@]}"} >/dev/null \
  || die "$(tail -n 1 "$INSTALL_LOG" | sed 's/^error: //')"

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

# --- 5. configuration and start: configure.sh, which the .pkg runs too -------------------------------------------

export IMMICH_INSTALL_LOG_STARTED=1
exec "$REPO/macos/native/configure.sh" --release "$RELEASE" --pg-prefix "$PG_PREFIX" ${ARGS[@]+"${ARGS[@]}"}
