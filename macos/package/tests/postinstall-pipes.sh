#!/bin/bash
# postinstall finds the user who opened Installer in ps' output, under `set -euo pipefail`. ps writes more than a pipe
# holds; a reader that stops at the first match leaves it to die of SIGPIPE, and the script fails before logging
# anything (macos/verification/m4-pkg-postinstall-sigpipe.md). This runs postinstall's first_user_running, and the line
# it replaced, against a process near the top of a process table padded past a pipe's 64 KB: the old one must fail,
# the new one must find the user every time.
#
# Usage: macos/package/tests/postinstall-pipes.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
function_source="$(sed -n '/^# BEGIN first_user_running/,/^# END first_user_running/p' "$HERE/../scripts/postinstall")"
[ -n "$function_source" ] || { echo "no first_user_running in postinstall" >&2; exit 1; }

pids=()
cleanup() { [ ${#pids[@]} -eq 0 ] || kill "${pids[@]}" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 1 1000); do
  sleep 300 &
  pids+=($!)
done
bytes="$(ps -axo user=,comm= | wc -c | tr -d ' ')"

# a process of this user's near the top of the table (low PID), as Installer was on the tester's Mac
target="$(ps -axo user=,comm= | awk -v me="$(id -un)" '$1 == me && !found { print $2; found = 1 }')"
echo "ps writes $bytes bytes; looking for $(id -un)'s $target, near the top"

old_failures=0 new_failures=0 runs=20
for _ in $(seq 1 "$runs"); do
  bash -c 'set -euo pipefail; u="$(ps -axo user=,comm= | awk -v t="$1" "\$2 == t && \$1 != \"root\" { print \$1; exit }")"; [ -n "$u" ]' \
    sh "$target" 2>/dev/null || old_failures=$((old_failures + 1))
  bash -c "set -euo pipefail; $function_source"$'\n''u="$(first_user_running "$1")"; [ "$u" = "$2" ]' \
    sh "$target" "$(id -un)" 2>/dev/null || new_failures=$((new_failures + 1))
done
echo "the line mac.2 had: failed $old_failures/$runs; first_user_running: failed $new_failures/$runs"
if [ "$bytes" -le 65536 ] || [ "$old_failures" -eq 0 ]; then
  echo "the old line never failed here, so this run proves nothing: is ps' output past 64 KB?" >&2
  exit 1
fi
[ "$new_failures" -eq 0 ] && echo "ok" || exit 1
