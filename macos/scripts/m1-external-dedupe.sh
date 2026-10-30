#!/bin/bash
# The whole external library check, from scratch: a test instance on the code before the fix (mac/develop), the
# problem reproduced on it, then the instance upgraded to this checkout and the fix checked.
#
# Usage: m1-external-dedupe.sh [NAS_FOLDER]   (default /tmp/immich-p1/nas, which m1_external_dedupe.py's photos fill)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work=/tmp/immich-p1
nas="${1:-$work/nas}"
home="$HOME/Library/Application Support/Immich-p1"
py="$HOME/Library/Application Support/Immich/current/ml/venv/bin/python"
ports=(--server-port 2286 --ml-port 3006 --db-port 5436 --redis-port 6383)
cd "$repo"
branch="$(git branch --show-current)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit or stash the changes first" >&2; exit 1; }

# a clean library: the files only, as the NAS has them
[ -x "$home/bin/immichctl" ] && "$home/bin/immichctl" uninstall --purge >/dev/null 2>&1 || true
rm -rf "$home" "$work/library" "$work/old-japanese-shop.jpg" "$nas/2026/new" "$nas/2026/copy"
find "$nas" -name '*.xmp' -delete
cp e2e/test-assets/albums/text/japanese-shop.jpg "$nas/2026/"

echo "== $(git rev-parse --short mac/develop) (mac/develop): the problem"
git checkout -q mac/develop
trap 'git checkout -q "$branch"' EXIT
macos/native/install.sh --home "$home" --library "$work/library" --label local.immich-p1 "${ports[@]}" --no-warm \
  >"$work/install-old.out" 2>&1
git checkout -q "$branch"
"$py" macos/scripts/m1_external_dedupe.py --url http://127.0.0.1:2286 --nas "$nas" before | tee "$work/e2e-before.txt"

echo "== $(git rev-parse --short HEAD) ($branch): the fix"
macos/native/install.sh --home "$home" --no-warm >"$work/install-new.out" 2>&1
"$home/bin/immichctl" status | grep release
"$py" macos/scripts/m1_external_dedupe.py --url http://127.0.0.1:2286 --nas "$nas" after | tee "$work/e2e-after.txt"
