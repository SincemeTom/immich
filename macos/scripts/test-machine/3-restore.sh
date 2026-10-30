#!/bin/bash
# Undoes 2-hide-homebrew.sh and 1-disable-native.sh: Homebrew back where it was, then the one-click Immich, its data and
# its LaunchAgents, started again. Uninstall the .pkg's Immich first, if it was installed: the two cannot run at once.
#
# Usage: 3-restore.sh [--dry-run]     (asks for the administrator password, for sudo)
set -euo pipefail

LABEL="${IMMICH_NATIVE_LABEL_PREFIX:-local.immich}"
HOME_DIR="${IMMICH_HOME:-$HOME/Library/Application Support/Immich}"
BACKUP="${IMMICH_TEST_BACKUP:-$HOME/Library/Application Support/Immich-pkg-test-backup}"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "  would run: $*"; else "$@"; fi; }

echo "==> Bringing Homebrew back"
shopt -s nullglob
hidden=()
for dir in /opt/homebrew.hidden-for-test /usr/local/*.hidden-for-test; do
  [ -d "$dir" ] && hidden+=("$dir")
done
if [ ${#hidden[@]} -eq 0 ]; then
  echo "  not hidden"
fi
for dir in ${hidden[@]+"${hidden[@]}"}; do
  target="${dir%.hidden-for-test}"
  if [ -e "$target" ]; then
    echo "  $target is there again, beside $dir: check them by hand" >&2
    exit 1
  fi
  echo "  $dir -> $target"
  run sudo mv "$dir" "$target"
done

echo "==> Bringing the one-click Immich back"
if [ ! -d "$BACKUP" ]; then
  echo "  nothing was turned off"
  exit 0
fi

if [ -d "$BACKUP/Immich" ]; then
  if [ -e "$HOME_DIR" ]; then
    echo "  $HOME_DIR is there (the .pkg's?): uninstall the .pkg's Immich, then run this again." >&2
    echo "  The one-click Immich's data is kept in $BACKUP/Immich" >&2
    exit 1
  fi
  echo "  its data"
  run mv "$BACKUP/Immich" "$HOME_DIR"
fi

agents=("$BACKUP/LaunchAgents"/*.plist)
for plist in ${agents[@]+"${agents[@]}"}; do
  if [ -e "$AGENTS/$(basename "$plist")" ]; then
    echo "  $AGENTS/$(basename "$plist") is there (the .pkg's?): uninstall the .pkg's Immich, then run this again." >&2
    exit 1
  fi
done
run mkdir -p "$AGENTS"
for plist in ${agents[@]+"${agents[@]}"}; do
  echo "  $(basename "$plist")"
  run mv "$plist" "$AGENTS/"
done

# the database first, the server last
for service in postgres valkey ml server; do
  plist="$AGENTS/$LABEL.$service.plist"
  if [ -e "$plist" ] || [ "$DRY" = 1 ]; then
    echo "  starting $service"
    run launchctl bootstrap "$DOMAIN" "$plist" || true
  fi
done
run rmdir "$BACKUP/LaunchAgents" "$BACKUP" 2>/dev/null || true

if [ "$DRY" = 0 ]; then
  echo "==> Waiting for it to answer"
  port=$(grep -h '^IMMICH_NATIVE_SERVER_PORT=' "$HOME_DIR/config/"*.env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "'\"")
  port=${port:-2283}
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$port/api/server/ping" >/dev/null; then
      echo "  up: http://127.0.0.1:$port"
      break
    fi
    sleep 2
  done
  "$HOME_DIR/bin/immichctl" status 2>/dev/null || true
fi

echo
echo "Done: Homebrew and the one-click Immich are back as they were."
