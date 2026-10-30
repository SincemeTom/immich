#!/bin/bash
# Turns off the one-click (install.sh) Immich on this Mac, so that it neither runs nor comes back at login, for a test
# of the .pkg. Its data stays where it is, for the .pkg to take over, and what the .pkg then rewrites (its settings,
# scripts and the release it runs) is saved; --fresh moves all of it aside instead, for a test of a new install.
# 3-restore.sh undoes all of it.
#
# Usage: 1-disable-native.sh [--fresh] [--dry-run]
set -euo pipefail

LABEL="${IMMICH_NATIVE_LABEL_PREFIX:-local.immich}"
HOME_DIR="${IMMICH_HOME:-$HOME/Library/Application Support/Immich}"
BACKUP="${IMMICH_TEST_BACKUP:-$HOME/Library/Application Support/Immich-pkg-test-backup}"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
FRESH=0 DRY=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then echo "  would run: $*"; else "$@"; fi; }

shopt -s nullglob
plists=("$AGENTS/$LABEL".*.plist)
if [ ${#plists[@]} -eq 0 ] && [ ! -d "$HOME_DIR" ]; then
  echo "No one-click Immich here ($AGENTS/$LABEL.*.plist, $HOME_DIR): nothing to turn off."
  exit 0
fi

echo "==> Stopping the one-click Immich"
# the server first, the database last, as immichctl stops them
for service in server ml valkey postgres; do
  if launchctl print "$DOMAIN/$LABEL.$service" >/dev/null 2>&1; then
    echo "  stopping $service"
    run launchctl bootout "$DOMAIN/$LABEL.$service" || true
  fi
done

echo "==> Keeping it from starting at login"
run mkdir -p "$BACKUP/LaunchAgents"
for plist in ${plists[@]+"${plists[@]}"}; do
  echo "  moving aside $(basename "$plist")"
  run mv "$plist" "$BACKUP/LaunchAgents/"
done

if [ "$FRESH" = 0 ] && [ -d "$HOME_DIR" ]; then
  echo "==> Saving what the .pkg rewrites when it takes over"
  run mkdir -p "$BACKUP/state"
  for file in config/native.env bin/run-service bin/immichctl; do
    [ -f "$HOME_DIR/$file" ] && run cp -p "$HOME_DIR/$file" "$BACKUP/state/$(basename "$file")"
  done
  # the release it runs, which the .pkg keeps as the one before its own
  if [ "$DRY" = 1 ]; then
    echo "  would save: current -> $(readlink "$HOME_DIR/current" 2>/dev/null || echo none)"
  else
    readlink "$HOME_DIR/current" >"$BACKUP/state/current" 2>/dev/null || true
  fi
fi

if [ "$FRESH" = 1 ] && [ -d "$HOME_DIR" ]; then
  echo "==> Moving its data aside, for a test of a new install"
  if [ -e "$BACKUP/Immich" ]; then
    echo "  $BACKUP/Immich is there already: run 3-restore.sh first" >&2
    exit 1
  fi
  run mv "$HOME_DIR" "$BACKUP/Immich"
  echo "  moved to $BACKUP/Immich"
fi

if [ "$DRY" = 0 ]; then
  sleep 2
  left=$(pgrep -fl "$HOME_DIR/" || true)
  if [ -n "$left" ]; then
    echo "==> Still running (stop them, or log out and in):"
    echo "$left"
    exit 1
  fi
fi

echo
echo "Done: the one-click Immich is off$([ "$FRESH" = 1 ] && echo ", its data moved aside" || echo ", its data kept for the .pkg to take over")."
echo "Next: 2-hide-homebrew.sh"
