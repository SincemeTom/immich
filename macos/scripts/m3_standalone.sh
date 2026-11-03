#!/bin/bash
# M3: the self-contained release, run the way the .pkg runs it, on this Mac, with Homebrew out of reach.
#
#   fresh     configure.sh from the release on a new install, as postinstall runs it: the models placed as it places
#             them, prepared in the background (well within Installer's 600 seconds); meanwhile the server runs, a photo
#             uploaded gets its thumbnail and its smart search waits (m4_warm_queue.py), running after without a
#             restart; then m0_e2e.py: sign-up, every
#             test format, videos, faces, OCR, smart search, transcoding, a database backup
#   takeover  an install.sh install first (Homebrew's PostgreSQL, Valkey and libvips, a release from install.sh) with
#             photos (m0_e2e.py), then configure.sh from the self-contained release on it, as the .pkg does on a Mac
#             that has one: the same photos, people and settings after, then m0_e2e.py again on it
#
# Every service of the self-contained release runs through a sandbox profile that hides Homebrew, ~/.local, ~/.cargo,
# the package cache and this checkout, and lets it reach nothing on the network but this Mac (no model downloads, no
# Homebrew). lsof then shows that none of their processes has anything of Homebrew open.
#
# Usage: macos/scripts/m3_standalone.sh RELEASE MODELS fresh|takeover|both
#   RELEASE  a release from macos/package/build-release.sh; MODELS  the models stage_models.py staged
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$(cd "${1:?usage: m3_standalone.sh RELEASE MODELS fresh|takeover|both}" && pwd -P)"
MODELS="$(cd "${2:?}" && pwd -P)"
WHAT="${3:-both}"
WORK=/tmp/m3
LIVE="$HOME/Library/Application Support/Immich"
# the live install's Python, for httpx and Pillow: a .pkg install's (ml/python), or an install.sh one's (ml/venv)
PYTHON="$LIVE/current/ml/python/bin/python3"
[ -x "$PYTHON" ] || PYTHON="$LIVE/current/ml/venv/bin/python"
[ -x "$PYTHON" ] || { echo "no Python with httpx and Pillow in $LIVE/current/ml" >&2; exit 1; }
mkdir -p "$WORK"
failures=0

check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = 1 ]; then echo "  [PASS] $name${detail:+: $detail}"; else echo "  [FAIL] $name${detail:+: $detail}"; failures=$((failures + 1)); fi
}

# a clone of the release whose run-service starts each service in the sandbox: configure.sh installs it as the
# install's own, so that every start, the first one too, goes through it
sandboxed_release() {
  local name="$1" release="$WORK/release-$1"
  rm -rf "$release"
  cp -cR "$SOURCE" "$release"
  sed -i '' "s/^id=.*/id=$(sed -n 's/^id=//p' "$SOURCE/RELEASE")-$name/" "$release/RELEASE"
  mv "$release/native/run-service" "$release/native/run-service.real"
  cat >"$release/native/run-service" <<'EOF'
#!/bin/bash
# m3_standalone.sh: run-service, in the sandbox
bin="$(cd "$(dirname "$0")" && pwd)"
cp -f "$bin/../current/native/run-service.real" "$bin/run-service.real"
exec /usr/bin/sandbox-exec -f "$bin/../config/m3-sandbox.sb" "$bin/run-service.real" "$@"
EOF
  chmod 755 "$release/native/run-service"
  echo "$release"
}

sandbox_profile() {
  mkdir -p "$1/config"
  cat >"$1/config/m3-sandbox.sb" <<EOF
(version 1)
(allow default)
(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local") (subpath "$HOME/.local") (subpath "$HOME/.cargo")
  (subpath "$HOME/.rustup") (subpath "$HOME/Library/Caches/immich-package") (subpath "$REPO"))
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
EOF
}

# the models in place, as postinstall moves them
place_models() {
  local target="$1/data/models"
  mkdir -p "$target"
  for model in "$MODELS"/*/*; do
    mkdir -p "$target/$(basename "$(dirname "$model")")"
    cp -cR "$model" "$target/$(basename "$(dirname "$model")")/"
  done
}

# every process of the install: none may have a file of Homebrew open
no_homebrew() {
  local home="$1" pids open
  # the services, and their children: postgres' backends, the server's workers, exiftool
  pids="$( { pgrep -f "$home/" || true; for pid in $(pgrep -f "$home/" || true); do pgrep -P "$pid" || true; done; } \
    | sort -u | tr '\n' ',' | sed 's/,$//')"
  open="$(lsof -p "$pids" 2>/dev/null | grep -c /opt/homebrew || true)"
  check "none of its $(echo "$pids" | tr ',' '\n' | wc -l | tr -d ' ') processes has a file of Homebrew open" \
    "$([ "$open" = 0 ] && echo 1 || echo 0)" "$open open"
  [ "$open" = 0 ] || { lsof -p "$pids" 2>/dev/null | grep /opt/homebrew || true; } | awk '{ print $1, $9 }' | sort -u | head -5
}

e2e() {
  local port="$1" ml_port="$2" log="$3"
  M0_FFPROBE="$SOURCE/ffmpeg/ffprobe" "$PYTHON" -u "$REPO/macos/scripts/m0_e2e.py" --url "http://127.0.0.1:$port" \
    --ml-url "http://127.0.0.1:$ml_port" >"$log" 2>&1 || true
  local summary
  summary="$(grep -E "^Result: [0-9]+/[0-9]+ checks passed" "$log" | tail -1)"
  { grep -E "\[FAIL\]" "$log" || true; } | head -10 | sed 's/^/    /'
  check "m0_e2e.py" "$(grep -q '\[FAIL\]' "$log" || [ -z "$summary" ] && echo 0 || echo 1)" "${summary:-no summary, see $log}"
}

# The models prepared in the background, as after the .pkg: configure.sh has just set it going. Meanwhile the server
# runs, a photo uploaded gets its thumbnail and its smart search waits; the warm-up then removes its LaunchAgent, and
# the same server, not restarted, takes up what waited.
background_warm() {
  local home="$1" port="$2" label="$3" asset waited=0 workers pid
  workers="$(cat "$home/run/server-workers" 2>/dev/null || echo none)"
  pid="$(launchctl print "gui/$(id -u)/$label.server" 2>/dev/null | awk '$1 == "pid" { print $3 }')"
  check "the server runs while the models are prepared, with its job worker" \
    "$(curl -fsS -m 5 "http://127.0.0.1:$port/api/server/ping" | grep -q pong && [ "$workers" = all ] && echo 1 || echo 0)" \
    "workers: $workers, pid ${pid:-?}"
  if "$PYTHON" "$REPO/macos/scripts/m4_warm_queue.py" upload "http://127.0.0.1:$port" >"$WORK/warm-queue.log" 2>&1; then
    check "a photo uploaded meanwhile gets its thumbnail, its smart search waiting" 1 \
      "$(head -1 "$WORK/warm-queue.log" | cut -c6-)"
  else
    check "a photo uploaded meanwhile gets its thumbnail, its smart search waiting" 0 \
      "$(head -3 "$WORK/warm-queue.log" | tr '\n' ' ')"
  fi
  asset="$(tail -1 "$WORK/warm-queue.log")"
  while [ -f "$HOME/Library/LaunchAgents/$label.warm.plist" ] && [ "$waited" -lt 1800 ]; do
    sleep 10
    waited=$((waited + 10))
  done
  check "the background warm-up finished and removed its LaunchAgent" \
    "$([ ! -f "$HOME/Library/LaunchAgents/$label.warm.plist" ] && echo 1 || echo 0)" \
    "about $waited s; $(grep -a 'ready after' "$home/logs/warm.log" 2>/dev/null | tail -1 | sed 's/^ *//')"
  local after
  after="$(launchctl print "gui/$(id -u)/$label.server" 2>/dev/null | awk '$1 == "pid" { print $3 }')"
  check "the same server, not restarted" "$([ -n "$pid" ] && [ "$pid" = "$after" ] \
    && curl -fsS -m 5 "http://127.0.0.1:$port/api/server/ping" | grep -q pong && echo 1 || echo 0)" \
    "pid ${pid:-?} before, ${after:-?} after"
  if "$PYTHON" "$REPO/macos/scripts/m4_warm_queue.py" check "http://127.0.0.1:$port" "$asset" >>"$WORK/warm-queue.log" 2>&1; then
    check "the photo's jobs ran after it" 1 "$(tail -1 "$WORK/warm-queue.log" | cut -c6-)"
  else
    check "the photo's jobs ran after it" 0 "$(tail -2 "$WORK/warm-queue.log" | tr '\n' ' ')"
  fi
}

# what the web UI shows under Help and About: this build's own source, at the commit that runs (AGPL section 13)
source_links() {
  local home="$1" port="$2" commit about
  commit="$(sed -n 's/^commit=//p' "$home/current/RELEASE")"
  about="$("$PYTHON" - "$port" <<'PY'
import json, sys, httpx
c = httpx.Client(base_url=f"http://127.0.0.1:{sys.argv[1]}", timeout=30)
token = c.post("/api/auth/login", json={"email": "m0@immich.local", "password": "m0-password"}).json()["accessToken"]
about = c.get("/api/server/about", headers={"Authorization": f"Bearer {token}"}).json()
print(json.dumps({k: about.get(k) for k in ("repository", "sourceCommit", "sourceUrl", "thirdPartySourceUrl")}))
PY
)"
  check "Help and About link this build's source at its commit" \
    "$(echo "$about" | grep -q "SincemeTom/immich/tree/$commit" && echo 1 || echo 0)" "$about"
  check "the licenses of everything it carries, in the release" \
    "$([ -s "$home/current/licenses/THIRD-PARTY-NOTICES.md" ] && [ -f "$home/current/licenses/immich/LICENSE" ] && echo 1 || echo 0)" \
    "$(grep -c '^| ' "$home/current/licenses/THIRD-PARTY-NOTICES.md" 2>/dev/null) rows"
}

uninstall() {
  local home="$1"
  # its logs, which uninstalling deletes, for what failed
  [ -d "$home/logs" ] && rm -rf "$WORK/logs-$(basename "$home")" && cp -R "$home/logs" "$WORK/logs-$(basename "$home")"
  [ -x "$home/bin/immichctl" ] && "$home/bin/immichctl" uninstall --purge >/dev/null 2>&1 || true
  rm -rf "$home"
}

# --- fresh -------------------------------------------------------------------------------------------------------

if [ "$WHAT" = fresh ] || [ "$WHAT" = both ]; then
  echo "== fresh: configure.sh from the self-contained release on a new install"
  home="$HOME/Library/Application Support/Immich-p10"
  uninstall "$home"
  rm -rf "$WORK/library-p10"
  release="$(sandboxed_release p10)"
  sandbox_profile "$home"
  place_models "$home"
  started=$SECONDS
  if "$release/native/configure.sh" --release "$release" --home "$home" --library "$WORK/library-p10" \
    --server-port 2294 --ml-port 3014 --db-port 5444 --redis-port 6391 --label local.immich-p10 --warm-in-background \
    >"$WORK/p10-configure.log" 2>&1; then
    # what Installer allows postinstall is 600 s; well within it, for a slower Mac
    check "configure.sh, as postinstall runs it, within 180 s" "$([ $((SECONDS - started)) -le 180 ] && echo 1 || echo 0)" \
      "$((SECONDS - started)) s"
  else
    check "configure.sh, as postinstall runs it" 0 "see $WORK/p10-configure.log"
    tail -n 20 "$WORK/p10-configure.log"
    exit 1
  fi
  { grep -E "smart search|ready after|video transcoding" "$WORK/p10-configure.log" || true; } | sed 's/^ */    /'
  # shellcheck source=/dev/null
  pg_prefix="$(. "$home/config/native.env" && echo "$IMMICH_NATIVE_PG_PREFIX")"
  check "PostgreSQL is the release's own" "$([ "$pg_prefix" = "$home/current/postgres" ] && echo 1 || echo 0)" "$pg_prefix"
  background_warm "$home" 2294 local.immich-p10
  # in this install's own logs (not the default install's, ~/Library/Logs/Immich)
  # shellcheck source=/dev/null
  log_dir="$(. "$home/config/native.env" && echo "$IMMICH_NATIVE_LOG_DIR")"
  check "no model was downloaded" "$(grep -q 'Downloading' "$log_dir/ml-warm.log" 2>/dev/null && echo 0 || echo 1)" "$log_dir"
  no_homebrew "$home"
  e2e 2294 3014 "$WORK/p10-e2e.log"
  source_links "$home" 2294
  no_homebrew "$home"
  "$home/bin/immichctl" status | sed 's/^/    /'
  uninstall "$home"
fi

# --- takeover ----------------------------------------------------------------------------------------------------

if [ "$WHAT" = takeover ] || [ "$WHAT" = both ]; then
  echo "== takeover: an install.sh install with photos, then the self-contained release on it"
  home="$HOME/Library/Application Support/Immich-p11"
  uninstall "$home"
  rm -rf "$WORK/library-p11" "$WORK/release-p11-brew"
  # what install.sh leaves after its build: a release of its own (this Mac's), Homebrew's PostgreSQL
  cp -cR "$(cd "$LIVE/current" && pwd -P)" "$WORK/release-p11-brew"
  sed -i '' "s/^id=.*/id=$(sed -n 's/^id=//p' "$WORK/release-p11-brew/RELEASE")-p11/" "$WORK/release-p11-brew/RELEASE"
  place_models "$home"
  if "$REPO/macos/native/configure.sh" --release "$WORK/release-p11-brew" --pg-prefix /opt/homebrew/opt/postgresql@17 \
    --home "$home" --library "$WORK/library-p11" --server-port 2295 --ml-port 3015 --db-port 5445 --redis-port 6392 \
    --label local.immich-p11 >"$WORK/p11-install.log" 2>&1; then
    check "the install.sh install (configure.sh with Homebrew's PostgreSQL)" 1
  else
    check "the install.sh install (configure.sh with Homebrew's PostgreSQL)" 0 "see $WORK/p11-install.log"
    tail -n 20 "$WORK/p11-install.log"
    exit 1
  fi
  e2e 2295 3015 "$WORK/p11-e2e-before.log"
  db() { "$home/bin/immichctl" psql -At -c "$1"; }
  before="$(db "select (select count(*) from asset where \"deletedAt\" is null), (select count(*) from asset_face), (select count(*) from smart_search), (select count(*) from asset_ocr), (select count(*) from \"user\"), (select md5(value::text) from system_metadata where key = 'system-config')")"
  echo "    before: assets|faces|smart search|ocr|users|settings = $before"

  release="$(sandboxed_release p11)"
  sandbox_profile "$home"
  started=$SECONDS
  if "$release/native/configure.sh" --release "$release" --home "$home" --warm-in-background >"$WORK/p11-takeover.log" 2>&1; then
    check "configure.sh from the self-contained release, on it, within 180 s" \
      "$([ $((SECONDS - started)) -le 180 ] && echo 1 || echo 0)" "$((SECONDS - started)) s"
  else
    check "configure.sh from the self-contained release, on it" 0 "see $WORK/p11-takeover.log"
    tail -n 20 "$WORK/p11-takeover.log"
    exit 1
  fi
  # shellcheck source=/dev/null
  pg_prefix="$(. "$home/config/native.env" && echo "$IMMICH_NATIVE_PG_PREFIX")"
  check "PostgreSQL now the release's own" "$([ "$pg_prefix" = "$home/current/postgres" ] && echo 1 || echo 0)" "$pg_prefix"
  check "ports and library kept" "$(grep -q 'IMMICH_NATIVE_SERVER_PORT=2295' "$home/config/native.env" \
    && grep -q "library-p11" "$home/config/native.env" && echo 1 || echo 0)"
  after="$(db "select (select count(*) from asset where \"deletedAt\" is null), (select count(*) from asset_face), (select count(*) from smart_search), (select count(*) from asset_ocr), (select count(*) from \"user\"), (select md5(value::text) from system_metadata where key = 'system-config')")"
  check "the same photos, faces, search index, text, users and settings" "$([ "$before" = "$after" ] && echo 1 || echo 0)" "$after"
  releases=("$home"/releases/*)
  check "the release before kept, for going back" "$([ ${#releases[@]} -eq 2 ] && echo 1 || echo 0)" \
    "$(for r in "${releases[@]}"; do basename "$r"; done | tr '\n' ' ')"
  background_warm "$home" 2295 local.immich-p11
  no_homebrew "$home"
  e2e 2295 3015 "$WORK/p11-e2e-after.log"
  no_homebrew "$home"
  uninstall "$home"
fi

echo
if [ "$failures" -eq 0 ]; then echo "m3: all passed"; else echo "m3: $failures failed"; exit 1; fi
