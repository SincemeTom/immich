#!/bin/bash
# Checks that a self-contained release runs on its own: every part of it is started with Homebrew, ~/.local (uv's
# Python), the build cache and this checkout unreadable, through a sandbox profile, as on a Mac that never had them.
# It runs from a clone of the release in a temporary folder, so that it also shows the release runs once moved.
#
#   libraries     every Mach-O file loads only what is in the release, or macOS's own
#   PostgreSQL    a new cluster with ICU, every extension Immich creates, a VectorChord index
#   Valkey        starts and answers
#   sharp         HEIC, JPEG XL, AVIF, camera RAW, WebP, PNG, TIFF, GIF, JPEG 2000, SVG, and BMP and PSD (ImageMagick)
#   Python        onnxruntime with CoreML, and the machine learning service's app
#   ffmpeg, gzip  run; gzip takes --rsyncable
#   signatures    with --signed: every Mach-O file signed by Developer ID, hardened runtime, timestamp
#
# Usage: macos/package/check-release.sh RELEASE [--signed]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$(cd "${1:?usage: check-release.sh RELEASE [--signed]}" && pwd -P)"
SIGNED="${2:-}"
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/immich-check.XXXXXX")" && pwd -P)"
RELEASE="$WORK/release"
# a clone (APFS: no space), somewhere else than it was built
cp -cR "$SOURCE" "$RELEASE"
PROFILE="$WORK/deny.sb"
failures=0

cat >"$PROFILE" <<EOF
(version 1)
(allow default)
(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local") (subpath "$HOME/.local") (subpath "$HOME/.cargo")
  (subpath "$HOME/.rustup") (subpath "$HOME/Library/Caches/immich-package") (subpath "$REPO"))
EOF
check() {
  local name="$1"
  shift
  if "$@" >"$WORK/out" 2>&1; then
    echo "  [PASS] $name$(tail -n 1 "$WORK/out" | sed 's/^/: /' | cut -c1-140)"
  else
    failures=$((failures + 1))
    echo "  [FAIL] $name"
    sed 's/^/         /' "$WORK/out" | tail -n 20
  fi
}
cleanup() {
  [ -f "$WORK/pg/postmaster.pid" ] && "$RELEASE/postgres/bin/pg_ctl" -D "$WORK/pg" -m immediate stop >/dev/null 2>&1 || true
  [ -n "${valkey_pid:-}" ] && kill "$valkey_pid" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# the sandbox itself: Homebrew's files must be unreadable in it
check "the sandbox hides Homebrew" bash -c "! sandbox-exec -f '$PROFILE' /bin/cat /opt/homebrew/bin/brew >/dev/null 2>&1 && echo hidden"

echo "== libraries"
check "every Mach-O file loads only the release's libraries, or macOS's" python3 "$REPO/macos/package/bundle_dylibs.py" --check "$RELEASE"

echo "== PostgreSQL"
pg="$RELEASE/postgres/bin"
port=$((20000 + RANDOM % 10000))
check "initdb with ICU, as configure.sh runs it" sandbox-exec -f "$PROFILE" "$pg/initdb" -D "$WORK/pg" -U postgres \
  --auth=trust --data-checksums --encoding=UTF8 --locale-provider=icu --icu-locale=en-US --locale=en_US.UTF-8
printf "listen_addresses = '127.0.0.1'\nport = %s\nunix_socket_directories = ''\nshared_preload_libraries = 'vchord'\n" \
  "$port" >>"$WORK/pg/postgresql.conf"
check "starts, with VectorChord preloaded" sandbox-exec -f "$PROFILE" "$pg/pg_ctl" -D "$WORK/pg" -l "$WORK/pg.log" -w start
psql() { sandbox-exec -f "$PROFILE" "$pg/psql" -h 127.0.0.1 -p "$port" -U postgres -X -v ON_ERROR_STOP=1 -At "$@"; }
check "every extension Immich creates" psql -c "CREATE EXTENSION vector; CREATE EXTENSION vchord;
  CREATE EXTENSION cube; CREATE EXTENSION earthdistance; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;
  CREATE EXTENSION \"uuid-ossp\";
  SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension"
check "a VectorChord index, and a search through it" psql -c "CREATE TABLE t (id serial, v vector(3));
  INSERT INTO t (v) SELECT ARRAY[random(), random(), random()]::vector FROM generate_series(1, 2000);
  CREATE INDEX ON t USING vchordrq (v vector_cosine_ops);
  SELECT count(*) FROM (SELECT id FROM t ORDER BY v <=> '[0.5,0.5,0.5]' LIMIT 5) s"
check "ICU collation, and uuid" psql -c "SELECT 'a' < 'B' COLLATE \"en-x-icu\", uuid_generate_v4() IS NOT NULL"
check "pg_dump, as database backups run it" bash -c "sandbox-exec -f '$PROFILE' '$pg/pg_dump' -h 127.0.0.1 -p $port \
  -U postgres postgres | sandbox-exec -f '$PROFILE' '$RELEASE/tools/bin/gzip' --rsyncable | wc -c | tr -d ' '"
"$pg/pg_ctl" -D "$WORK/pg" -m fast stop >/dev/null

echo "== Valkey"
vport=$((30000 + RANDOM % 10000))
sandbox-exec -f "$PROFILE" "$RELEASE/valkey/bin/valkey-server" --port "$vport" --bind 127.0.0.1 --save "" \
  --dir "$WORK" >"$WORK/valkey.log" 2>&1 &
valkey_pid=$!
sleep 1
check "starts and answers" sandbox-exec -f "$PROFILE" "$RELEASE/valkey/bin/valkey-cli" -p "$vport" ping
kill "$valkey_pid" 2>/dev/null || true

echo "== sharp (libvips, ImageMagick)"
samples=()
for pattern in "motionphoto/*.heic" "jxl/*.jxl" "avif/*.avif" "raw/Ricoh/GR3/*.DNG" "raw/Nikon/D700/*.nef" \
  "raw/Canon/*.CR2" "webp/*.webp" "png/*.png"; do
  # shellcheck disable=SC2086,SC2012
  sample="$(ls "$REPO"/e2e/test-assets/formats/$pattern 2>/dev/null | head -1 || true)"
  [ -n "$sample" ] && cp "$sample" "$WORK/" && samples+=("$WORK/$(basename "$sample")")
done
node="$RELEASE/node/bin/node"
(
  cd "$RELEASE/server"
  "$node" -e "
    const sharp = require('sharp'); const w = '$WORK';
    const base = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#c03030' } });
    Promise.all([base().tiff().toFile(w + '/made.tif'), base().gif().toFile(w + '/made.gif'),
      base().jp2().toFile(w + '/made.jp2')]).then(() => require('fs').writeFileSync(w + '/made.svg',
      '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"48\"><rect width=\"64\" height=\"48\" fill=\"red\"/><text x=\"4\" y=\"30\">Aa</text></svg>'))"
)
samples+=("$WORK/made.tif" "$WORK/made.gif" "$WORK/made.jp2" "$WORK/made.svg")
if [ -x /opt/homebrew/bin/magick ]; then
  /opt/homebrew/bin/magick -size 64x48 xc:red "$WORK/made.bmp"
  /opt/homebrew/bin/magick -size 64x48 xc:blue "$WORK/made.psd"
  samples+=("$WORK/made.bmp" "$WORK/made.psd")
fi
# beside the server's node_modules, where it finds sharp
cp "$REPO/macos/package/tests/sharp-formats.cjs" "$RELEASE/server/"
magick_modules="$(echo "$RELEASE"/imagemagick/modules-*)"
sharp_check() {
  (cd "$RELEASE/server" && env -i HOME="$HOME" PATH=/usr/bin:/bin VIPSHOME="$RELEASE/vips" \
    MAGICK_CODER_MODULE_PATH="$magick_modules/coders" MAGICK_CODER_FILTER_PATH="$magick_modules/filters" \
    MAGICK_CONFIGURE_PATH="$RELEASE/imagemagick/etc" FONTCONFIG_FILE="$RELEASE/fontconfig/fonts.conf" \
    sandbox-exec -f "$PROFILE" "$node" sharp-formats.cjs "$@")
}
check "every format the server reads (${#samples[@]} samples)" sharp_check "${samples[@]}"
sed -n '1,30p' "$WORK/out" | grep -E "ok|FAIL" | sed 's/^  /         /'
# Where Homebrew is there (a Mac that ran install.sh), nothing of it may load beside the release's own: libvips' and
# ImageMagick's plugins are found by path, not by the dynamic linker
if [ -d /opt/homebrew/opt/vips ]; then
  # what the process has mapped, as lsof lists it once every sample is decoded: DYLD_PRINT_LIBRARIES says nothing
  # under the hardened runtime of a signed release
  homebrew_loads() {
    cat >"$RELEASE/server/hold.cjs" <<'JS'
require('./sharp-formats.cjs');
const exit = process.exit;
process.exit = (code) => { console.log('decoded'); setTimeout(() => exit(code), 3000); };
JS
    (cd "$RELEASE/server" && exec env -i HOME="$HOME" PATH=/usr/bin:/bin VIPSHOME="$RELEASE/vips" \
      MAGICK_CODER_MODULE_PATH="$magick_modules/coders" MAGICK_CODER_FILTER_PATH="$magick_modules/filters" \
      MAGICK_CONFIGURE_PATH="$RELEASE/imagemagick/etc" FONTCONFIG_FILE="$RELEASE/fontconfig/fonts.conf" \
      "$node" hold.cjs "$@" >"$WORK/hold.out" 2>&1) &
    local pid=$! count
    for _ in $(seq 1 60); do grep -q decoded "$WORK/hold.out" 2>/dev/null && break; sleep 0.5; done
    lsof -p "$pid" >"$WORK/lsof.txt" 2>/dev/null || true
    wait "$pid" || true
    # code, which two copies of in one process could crash it; a data file (libexif's translations, at the path it was
    # built with) only changes the language of a message, and is not there without Homebrew
    count="$( { grep /opt/homebrew "$WORK/lsof.txt" || true; } | grep -cE '\.(dylib|so)$|/bin/' || true)"
    { grep /opt/homebrew "$WORK/lsof.txt" || true; } | awk '{ print $9 }' | grep -E '\.(dylib|so)$|/bin/' | head -5
    data="$( { grep /opt/homebrew "$WORK/lsof.txt" || true; } | grep -vcE '\.(dylib|so)$|/bin/' || true)"
    echo "$count libraries of Homebrew loaded ($data data files read), $(grep -cE "$RELEASE/(lib|vips|imagemagick)/" "$WORK/lsof.txt") of the release"
    [ "$count" -eq 0 ] && grep -q "$RELEASE/imagemagick/" "$WORK/lsof.txt"
  }
  check "with Homebrew there, none of it loads" homebrew_loads "${samples[@]}"
fi

echo "== Python and machine learning"
# from the service's own folder, as run-service starts it: the folder Python starts in is on its import path
cd "$RELEASE/ml"
py="$RELEASE/ml/python/bin/python3"
check "onnxruntime has CoreML" sandbox-exec -f "$PROFILE" "$py" -c \
  'import onnxruntime as o; p = o.get_available_providers(); assert "CoreMLExecutionProvider" in p, p; print(" ".join(p))'
check "the service's app loads" env -i HOME="$HOME" PYTHONPATH="$RELEASE/ml" PYTHONDONTWRITEBYTECODE=1 \
  MACHINE_LEARNING_CACHE_FOLDER="$WORK/models" sandbox-exec -f "$PROFILE" "$py" -c \
  'import immich_ml.main, cv2, numpy, PIL, tokenizers, huggingface_hub, uvicorn; print("immich_ml", cv2.__version__, numpy.__version__)'

echo "== ffmpeg, gzip"
check "ffmpeg with VideoToolbox and tonemapx" bash -c "sandbox-exec -f '$PROFILE' '$RELEASE/ffmpeg/ffmpeg' -hide_banner -encoders \
  | grep -q hevc_videotoolbox && sandbox-exec -f '$PROFILE' '$RELEASE/ffmpeg/ffmpeg' -hide_banner -filters | grep -q tonemapx && echo yes"
check "ffprobe" sandbox-exec -f "$PROFILE" "$RELEASE/ffmpeg/ffprobe" -version
check "gzip --rsyncable" bash -c "echo immich | sandbox-exec -f '$PROFILE' '$RELEASE/tools/bin/gzip' --rsyncable | gzip -dc"

if [ "$SIGNED" = --signed ]; then
  echo "== signatures"
  check "every Mach-O file: Developer ID, hardened runtime, secure timestamp" python3 - "$RELEASE" <<'PY'
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[0]).parent))
release = Path(sys.argv[1])
magic = {b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
files = [p for p in release.rglob("*") if p.is_file() and not p.is_symlink() and p.open("rb").read(4) in magic]
bad = []
for f in files:
    info = subprocess.run(["codesign", "-dvvv", str(f)], capture_output=True, text=True).stderr
    if "Authority=Developer ID Application" not in info or "runtime" not in info or "Timestamp=" not in info:
        bad.append(str(f.relative_to(release)))
    elif subprocess.run(["codesign", "--verify", "--strict", str(f)], capture_output=True).returncode:
        bad.append(f"{f.relative_to(release)} (does not verify)")
for b in bad[:20]:
    print(b)
print(f"{len(files) - len(bad)} of {len(files)} signed")
sys.exit(1 if bad else 0)
PY
fi

echo
if [ "$failures" -eq 0 ]; then echo "release check: all passed"; else echo "release check: $failures failed"; exit 1; fi
