#!/bin/bash
# Hides Homebrew from this Mac for a test of the .pkg, by renaming its folder: whatever still uses it fails to start, so
# that the .pkg is shown to bring all it needs. Nothing is uninstalled; 3-restore.sh renames it back.
#
# Usage: 2-hide-homebrew.sh [--dry-run]     (asks for the administrator password, for sudo)
set -euo pipefail

LABEL="${IMMICH_NATIVE_LABEL_PREFIX:-local.immich}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "  would run: $*"; else "$@"; fi; }

# Apple silicon's Homebrew, and the folders of an Intel one, if any
targets=()
[ -d /opt/homebrew ] && targets+=(/opt/homebrew)
for dir in /usr/local/Homebrew /usr/local/Cellar /usr/local/opt /usr/local/Caskroom; do
  [ -d "$dir" ] && targets+=("$dir")
done

if [ ${#targets[@]} -eq 0 ]; then
  if ls -d /opt/homebrew.hidden-for-test /usr/local/*.hidden-for-test >/dev/null 2>&1; then
    echo "Homebrew is hidden already. 3-restore.sh brings it back."
  else
    echo "No Homebrew on this Mac: nothing to hide."
  fi
  exit 0
fi

if [ "$DRY" = 0 ] && launchctl list | grep -qF "$LABEL."; then
  echo "The one-click Immich is still loaded: run 1-disable-native.sh first." >&2
  exit 1
fi

echo "==> Stopping Homebrew's services"
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$brew" ]; then
    "$brew" services list 2>/dev/null | awk 'NR > 1 && $2 == "started" { print $1 }' | while read -r formula; do
      echo "  stopping $formula"
      run "$brew" services stop "$formula" || true
    done
  fi
done

running=$(for target in "${targets[@]}"; do pgrep -fl "^$target/" || true; done)
if [ -n "$running" ]; then
  echo "==> Still running from Homebrew (quit them first):"
  echo "$running"
  [ "$DRY" = 0 ] && exit 1
fi

echo "==> Hiding Homebrew"
for target in "${targets[@]}"; do
  if [ -e "$target.hidden-for-test" ]; then
    echo "  $target.hidden-for-test is there already: check it by hand" >&2
    exit 1
  fi
  echo "  $target -> $target.hidden-for-test"
  run sudo mv "$target" "$target.hidden-for-test"
done

echo
echo "Done: Homebrew is hidden. 'brew' and what it installed no longer work, until 3-restore.sh."
echo "Open a new Terminal window before testing, so that none of its tools are remembered."
