#!/bin/bash
# Builds a self-contained Immich release from this checkout, for the .pkg: everything it runs is inside it, and it runs
# wherever it is moved, on an Apple Silicon Mac without Homebrew or developer tools.
#
#   server, web UI, core plugin   built as install.sh builds them
#   node, jellyfin-ffmpeg         the versions mise.lock pins (self-contained already)
#   sharp + libvips               built against Homebrew's libvips, which reads HEIC, JPEG XL and camera RAW; libvips,
#                                 its modules (heif, jxl, magick), ImageMagick's coders and what they load are copied in
#   PostgreSQL + pgvector +       built from source with the versions Homebrew has (the same as an install.sh install's,
#   VectorChord                   whose database the .pkg takes over), ICU, lz4 and zstd copied in
#   Valkey, GNU gzip              Homebrew's, with what they load
#   Python + machine learning     uv's standalone CPython, with the locked dependencies installed into it
#   geodata                       for reverse geocoding
#
# Homebrew and the tools install.sh uses are needed to build, not to run. Downloads are cached in
# ~/Library/Caches/immich-package.
#
# Usage: macos/package/build-release.sh [--out DIR]     (default DIR: macos/package/build)
#   prints the release folder last
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${IMMICH_PACKAGE_CACHE:-$HOME/Library/Caches/immich-package}"
OUT="$REPO/macos/package/build"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done
case "$OUT" in *" "*) echo "--out must have no spaces: PostgreSQL's and VectorChord's makefiles split it" >&2; exit 64 ;; esac

BREW=/opt/homebrew/bin/brew
BREW_PREFIX=/opt/homebrew
PG_FORMULA=postgresql@17
MISE_UNUSED="java,terragrunt,opentofu,npm:@openapitools/openapi-generator-cli,npm:oazapfts,github:extism/cli"
VIPS_MODULES=(heif jxl magick)

export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 HOMEBREW_NO_ENV_HINTS=1
export PATH="$BREW_PREFIX/bin:$BREW_PREFIX/opt/rustup/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export MISE_TRUSTED_CONFIG_PATHS="$REPO/mise.toml" MISE_YES=1 MISE_DISABLE_TOOLS="$MISE_UNUSED"
export UV_PYTHON_PREFERENCE=only-managed
# Homebrew's bottles here are built for macOS 15, and so is everything this compiles (PostgreSQL, pgvector, VectorChord,
# sharp), rather than for this Mac's version, which compilers assume otherwise; with Apple's clang, whatever the shell
# had set
export MACOSX_DEPLOYMENT_TARGET=15.0
export CC=/usr/bin/clang CXX=/usr/bin/clang++

mkdir -p "$CACHE/src" "$OUT"
LOG="$OUT/build-release.log"
: >"$LOG"
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; printf '\n==> %s (%s)\n' "$1" "$(date '+%H:%M:%S')" >>"$LOG"; }
info() { printf '    %s\n' "$1" | tee -a "$LOG"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
quiet() { "$@" >>"$LOG" 2>&1; }
on_exit() {
  local status=$?
  [ "$status" -eq 0 ] || { echo; echo "failed (exit $status), the end of $LOG:" >&2; tail -n 30 "$LOG" >&2; }
}
trap on_exit EXIT
mise_exec() { (cd "$REPO" && mise exec -- "$@"); }
fetch() {
  local url="$1" file="$CACHE/src/$2"
  [ -s "$file" ] || { quiet curl -fsSL --retry 3 -o "$file.part" "$url" && mv "$file.part" "$file"; }
  echo "$file"
}

# --- checks and tools --------------------------------------------------------------------------------------------

step "Checking the build Mac"
[ "$(uname -m)" = arm64 ] || die "build on an Apple Silicon Mac"
[ -x "$BREW" ] || die "Homebrew is needed to build (not to run): https://brew.sh"
SDKROOT="$(xcrun --show-sdk-path 2>/dev/null)" && [ -d "$SDKROOT" ] || die "no macOS SDK: xcode-select --install"
export SDKROOT
formulae=("$PG_FORMULA" pgvector valkey vips imagemagick gzip lz4 zstd llvm@18 rustup pkg-config mise uv)
missing=()
for formula in "${formulae[@]}"; do
  "$BREW" list --versions "$formula" >/dev/null 2>&1 || missing+=("$formula")
done
[ ${#missing[@]} -eq 0 ] || { info "installing ${missing[*]}"; quiet "$BREW" install "${missing[@]}"; }
quiet bash -c "cd '$REPO' && mise install --locked"

# the versions an install.sh install runs, so that the .pkg can take over its database
PG_VERSION="$("$BREW_PREFIX/opt/$PG_FORMULA/bin/postgres" --version | awk '{ print $3 }')"
PGVECTOR_VERSION="$("$BREW" list --versions pgvector | awk '{ print $2 }' | sed 's/_.*//')"
VCHORD_VERSION="$(sed -n 's/.*immich-app\/postgres:[0-9]*-vectorchord\([0-9.]*\)-.*/\1/p' "$REPO/docker/docker-compose.yml" | head -1)"
ICU_PREFIX="$(cd "$BREW_PREFIX/opt" && for d in icu4c@*; do echo "$BREW_PREFIX/opt/$d"; done | sort -V | tail -1)"
# the ICU Homebrew's PostgreSQL uses, whose collations an install.sh database was made with
pg_icu="$(otool -L "$BREW_PREFIX/opt/$PG_FORMULA/bin/postgres" | sed -n 's#.*/opt/\(icu4c@[0-9]*\)/lib/.*#\1#p' | head -1)"
[ -n "$pg_icu" ] && ICU_PREFIX="$BREW_PREFIX/opt/$pg_icu"
info "PostgreSQL $PG_VERSION, pgvector $PGVECTOR_VERSION, VectorChord $VCHORD_VERSION, ICU $(basename "$ICU_PREFIX")"

VERSION="$(sed -n 's/^  "version": "\(.*\)",/\1/p' "$REPO/server/package.json" | head -1)"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
DIRTY="$(git -C "$REPO" status --porcelain --untracked-files=no)"
# A release: a clean checkout of a tag v<upstream version>-mac.<n>, as macos/verification/m3-pkg.md ("正式版") makes one; anything
# else is a development build, named by its commit
TAG="$(git -C "$REPO" describe --tags --exact-match --match 'v*-mac.*' HEAD 2>/dev/null || true)"
if [ -n "$TAG" ] && [ -z "$DIRTY" ]; then
  case "$TAG" in "v$VERSION-mac."*) ;; *) die "tag $TAG does not match server/package.json's version $VERSION" ;; esac
  RELEASE_ID="${TAG#v}"
  CHANNEL=release
else
  TAG=""
  RELEASE_ID="$VERSION-$COMMIT-standalone"
  CHANNEL=development
  [ -z "$DIRTY" ] || RELEASE_ID="$RELEASE_ID-dirty-$(date +%Y%m%d%H%M%S)"
fi
RELEASE="$OUT/$RELEASE_ID"
rm -rf "$RELEASE"
mkdir -p "$RELEASE"/{node/bin,ffmpeg,ml,tools/bin,valkey/bin,native,build/plugins/immich-plugin-core}

# --- server, web UI, node, ffmpeg --------------------------------------------------------------------------------

step "Server, web UI and core plugin"
quiet mise_exec pnpm --filter immich --filter immich-web --filter @immich/sdk --filter @immich/plugin-sdk \
  --filter @immich/plugin-core install --frozen-lockfile
quiet mise_exec pnpm --filter @immich/sdk --filter @immich/plugin-sdk build
quiet mise_exec pnpm --filter immich build
quiet mise_exec pnpm --filter immich-web build
quiet mise_exec pnpm --filter @immich/plugin-core build
quiet mise_exec pnpm --filter immich --prod --no-optional deploy "$RELEASE/server"
quiet mise_exec env SHARP_FORCE_GLOBAL_LIBVIPS=true pnpm --config.verify-deps-before-run=false \
  --dir "$RELEASE/server/node_modules/sharp" exec npm run build
# of sharp's build, only the module it loads: its object files and makefiles are not to be shipped (nor signed)
sharp_src="$(cd "$RELEASE/server/node_modules/sharp/src" && pwd -P)"
find "$sharp_src/build" -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} +
find "$sharp_src/build/Release" -mindepth 1 -maxdepth 1 ! -name 'sharp-*.node' -exec rm -rf {} +
find "$sharp_src" \( -name '*.o' -o -name '*.a' \) -delete
cp "$(mise_exec which node)" "$RELEASE/node/bin/node"
cp -R "$REPO/web/build" "$RELEASE/build/www"
cp -R "$REPO/packages/plugin-core/dist" "$REPO/packages/plugin-core/manifest.json" \
  "$RELEASE/build/plugins/immich-plugin-core/"
ffmpeg_dir="$(dirname "$(mise_exec which ffmpeg)")"
cp "$ffmpeg_dir/ffmpeg" "$ffmpeg_dir/ffprobe" "$RELEASE/ffmpeg/"
info "node $("$RELEASE/node/bin/node" -v), jellyfin-ffmpeg $(basename "$ffmpeg_dir")"

step "libvips modules and ImageMagick coders"
vips_lib="$(cd "$BREW_PREFIX/opt/vips/lib" && pwd -P)"
modules="$(cd "$vips_lib" && ls -d vips-modules-*)"
mkdir -p "$RELEASE/vips/lib/$modules"
for module in "${VIPS_MODULES[@]}"; do
  cp "$vips_lib/$modules/vips-$module.dylib" "$RELEASE/vips/lib/$modules/"
done
magick_lib="$(cd "$BREW_PREFIX/opt/imagemagick/lib/ImageMagick" && pwd -P)"
mkdir -p "$RELEASE/imagemagick"
cp -R "$magick_lib"/modules-* "$RELEASE/imagemagick/"
cp -R "$BREW_PREFIX/opt/imagemagick/etc/ImageMagick-7" "$RELEASE/imagemagick/etc"
# ImageMagick loads a coder through its libtool .la file, and libltdl tries the folder the .la names first: Homebrew's,
# whose coders and their own MagickCore would load beside the release's on a Mac that has them. Not installed, a module
# loads from the folder its .la is in.
find "$RELEASE/imagemagick" -name '*.la' -exec sed -i '' -e "s#^libdir=.*#libdir=''#" \
  -e "s#^dependency_libs=.*#dependency_libs=''#" -e 's#^installed=.*#installed=no#' {} +
# librsvg's text goes through fontconfig, which would look for its configuration in Homebrew
mkdir -p "$RELEASE/fontconfig"
cat >"$RELEASE/fontconfig/fonts.conf" <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <dir>~/Library/Fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
EOF
info "libvips $modules: ${VIPS_MODULES[*]}; ImageMagick $(find "$RELEASE"/imagemagick/modules-*/coders -name '*.so' | wc -l | tr -d ' ') coders"

# --- PostgreSQL --------------------------------------------------------------------------------------------------

step "PostgreSQL $PG_VERSION"
src="$(fetch "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" "postgresql-$PG_VERSION.tar.bz2")"
build="$CACHE/build/postgresql-$PG_VERSION"
rm -rf "$build" && mkdir -p "$build"
tar -xjf "$src" -C "$build" --strip-components 1
(
  cd "$build"
  export PKG_CONFIG_PATH="$ICU_PREFIX/lib/pkgconfig:$BREW_PREFIX/opt/lz4/lib/pkgconfig:$BREW_PREFIX/opt/zstd/lib/pkgconfig"
  # what Immich and its extensions need, and what an install.sh database was made with (ICU collations, lz4 and
  # zstd compression); nothing that would link a library from outside for no use (OpenSSL, Kerberos, readline)
  quiet ./configure --prefix="$RELEASE/postgres" --with-icu --with-lz4 --with-zstd --with-uuid=e2fs \
    --without-readline --without-openssl --without-gssapi --without-ldap --without-perl --without-python \
    --without-tcl --disable-nls --disable-debug
  quiet make -j "$(sysctl -n hw.ncpu)" world-bin
  quiet make install-world-bin
)
PG_CONFIG="$RELEASE/postgres/bin/pg_config"
info "$("$RELEASE/postgres/bin/postgres" --version)"

step "pgvector $PGVECTOR_VERSION"
src="$(fetch "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz" "pgvector-$PGVECTOR_VERSION.tar.gz")"
build="$CACHE/build/pgvector-$PGVECTOR_VERSION"
rm -rf "$build" && mkdir -p "$build"
tar -xzf "$src" -C "$build" --strip-components 1
# no -march=native, which pgvector leaves out on Apple Silicon anyway: the release runs on any M-series Mac
quiet make -C "$build" PG_CONFIG="$PG_CONFIG" OPTFLAGS="" -j "$(sysctl -n hw.ncpu)"
quiet make -C "$build" PG_CONFIG="$PG_CONFIG" OPTFLAGS="" install

step "VectorChord $VCHORD_VERSION"
src="$CACHE/src/vectorchord-$VCHORD_VERSION"
[ -d "$src" ] || quiet git clone --depth 1 --branch "$VCHORD_VERSION" https://github.com/tensorchord/VectorChord.git "$src"
toolchain="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$src/rust-toolchain.toml")"
quiet rustup toolchain install "$toolchain" --profile minimal
command -v cargo-make >/dev/null 2>&1 || quiet cargo install cargo-make --locked
(
  cd "$src"
  # cargo would reuse what it built against an earlier release, linked to that release's postgres by its path
  rm -rf ./build/raw ./target
  # the recipe of VectorChord's own macOS CI job (psql_macos in .github/workflows/check.yml)
  export CC="$BREW_PREFIX/opt/llvm@18/bin/clang" PGRX_PG_CONFIG_PATH="$PG_CONFIG"
  quiet cargo make build -o ./build/raw
  quiet make PG_CONFIG="$PG_CONFIG" install
)
ls "$RELEASE"/postgres/share/extension/vchord.control "$RELEASE"/postgres/lib/vchord.dylib >/dev/null \
  || die "VectorChord did not install into the release"
# what only building against it needs
rm -rf "$RELEASE/postgres/include" "$RELEASE/postgres/lib/pgxs" "$RELEASE/postgres/lib/pkgconfig"
rm -f "$RELEASE"/postgres/lib/*.a

step "Valkey and GNU gzip"
cp "$BREW_PREFIX/opt/valkey/bin/valkey-server" "$BREW_PREFIX/opt/valkey/bin/valkey-cli" "$RELEASE/valkey/bin/"
# GNU's, for the --rsyncable database backups use, which macOS's gzip rejects
cp "$BREW_PREFIX/opt/gzip/bin/gzip" "$RELEASE/tools/bin/"
info "$("$RELEASE/valkey/bin/valkey-server" --version | awk '{ print $1, $3 }'), $("$RELEASE/tools/bin/gzip" --version | head -1)"

# --- machine learning --------------------------------------------------------------------------------------------

step "Python and the machine learning service"
python="$(uv python find 3.12)"
python_home="$(cd "$(dirname "$python")/.." && pwd -P)"
cp -R "$python_home" "$RELEASE/ml/python"
py="$RELEASE/ml/python/bin/python3.12"
# the name run-service starts it by (see there)
[ -e "$RELEASE/ml/python/bin/python" ] || ln -s python3.12 "$RELEASE/ml/python/bin/python"
(
  cd "$REPO/machine-learning"
  quiet uv export --frozen --extra cpu --no-dev --no-emit-project --format requirements-txt -o "$CACHE/build/ml-requirements.txt"
)
# into the standalone Python itself, not a venv, whose interpreter would be a link to this Mac's uv. Exactly what the
# lock pins (--no-deps): resolving again would add what the lock overrides away, as uv sync does not. rapidocr asks for
# opencv-python, which the lock replaces with the headless build: both in one site-packages make a cv2 of the two, and
# 5.0's half has no convertFp16, which the fp16 models' input path calls (every face and OCR request failed).
quiet uv pip install --python "$py" --break-system-packages --no-progress --no-deps -r "$CACHE/build/ml-requirements.txt"
"$py" - "$CACHE/build/ml-requirements.txt" <<'PY' || die "the machine learning packages are not the lock's"
import re
import sys
from importlib.metadata import distributions

from packaging.requirements import Requirement


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


# each requirement, its continuation lines (hashes) and comments left out
lines = [line.split(" \\")[0].strip() for line in open(sys.argv[1]) if line[:1].isalnum()]
wanted, excluded = {}, set()
for line in lines:
    requirement = Requirement(line)
    name = norm(requirement.name)
    if requirement.marker is not None and not requirement.marker.evaluate():
        excluded.add(name)  # another platform's, or overridden away by the lock (sys_platform == 'never')
        continue
    pins = [spec.version for spec in requirement.specifier if spec.operator == "=="]
    wanted[name] = pins[0] if pins else None  # None: a direct reference (git), any version of it
installed = {norm(d.metadata["Name"]): d.version for d in distributions()}
problems = [f"{name} {version}: not in the lock" for name, version in installed.items()
            if name not in wanted and name not in excluded and name not in {"pip", "setuptools", "wheel"}]
problems += [f"{name} {installed[name]}: the lock leaves it out here, installed" for name in excluded & installed.keys()
             if name not in wanted]
problems += [f"{name}: {installed.get(name)}, the lock pins {version}" for name, version in wanted.items()
             if name not in installed or (version is not None and installed[name] != version)]
for problem in problems:
    print(f"    {problem}")
if not problems:
    print(f"    {len(installed)} packages, as the lock pins them")
sys.exit(1 if problems else 0)
PY
rsync -a --exclude __pycache__ "$REPO/machine-learning/immich_ml" "$RELEASE/ml/"
providers="$("$py" -c 'import onnxruntime as o; print(" ".join(o.get_available_providers()))')"
case " $providers " in *" CoreMLExecutionProvider "*) ;; *) die "onnxruntime has no CoreML provider ($providers)" ;; esac
quiet "$py" -m compileall -q -j 0 "$RELEASE/ml"
info "Python $("$py" -c 'import platform; print(platform.python_version())'), onnxruntime: $providers"

# --- geodata, scripts, libraries ---------------------------------------------------------------------------------

step "Geodata"
geodata="$CACHE/geodata"
if [ ! -s "$geodata/geodata-date.txt" ]; then
  rm -rf "$geodata" && mkdir -p "$geodata"
  (
    cd "$geodata"
    quiet curl -fsSLO --retry 3 https://download.geonames.org/export/dump/cities500.zip
    for file in admin1CodesASCII.txt admin2Codes.txt countryInfo.txt; do
      quiet curl -fsSLO --retry 3 "https://download.geonames.org/export/dump/$file"
    done
    quiet curl -fsSLO --retry 3 https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson
    quiet unzip -oq cities500.zip
    rm cities500.zip
    date -u +%Y-%m-%dT%H:%M:%S+00:00 | tr -d '\n' >geodata-date.txt
  )
fi
cp -R "$geodata" "$RELEASE/build/geodata"
info "from $(cat "$geodata/geodata-date.txt")"

step "Bundling the libraries it loads"
install -m 755 "$REPO/macos/native/run-service" "$REPO/macos/native/immichctl" "$REPO/macos/native/configure.sh" \
  "$RELEASE/native/"
python3 "$REPO/macos/package/bundle_dylibs.py" "$RELEASE" | tee -a "$LOG" | sed 's/^/    /'
# the macOS it needs: the highest any of its Mach-O files was built for
macos_min="$(find "$RELEASE" -type f \( -name '*.dylib' -o -name '*.so' -o -name '*.node' -o -perm -u+x \) -print0 \
  | xargs -0 -n 50 otool -l 2>/dev/null | awk '/LC_BUILD_VERSION/ { b = 1 } b && $1 == "platform" { p = $2 }
      b && $1 == "minos" { if (p == 1) print $2; b = 0 }' | sort -V | tail -1)"
info "runs on macOS $macos_min or later"

cat >"$RELEASE/RELEASE" <<EOF
id=$RELEASE_ID
version=$VERSION
commit=$(git -C "$REPO" rev-parse HEAD)
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
standalone=1
channel=$CHANNEL
tag=$TAG
macos_min=$macos_min
node=$("$RELEASE/node/bin/node" -v)
postgres=$PG_VERSION
pgvector=$PGVECTOR_VERSION
vectorchord=$VCHORD_VERSION
EOF
touch "$RELEASE/.complete"

step "Done: $(du -sh "$RELEASE" | awk '{ print $1 }')"
echo "$RELEASE"
