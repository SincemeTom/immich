#!/usr/bin/env bash
# M0: decodes every image in e2e/test-assets/formats the way Immich's thumbnail job needs them (load, orient, resize to a
# 1440px preview and a 250px webp thumbnail) with a given libvips, and reports which formats fail.
# Usage: macos/scripts/m0-vips-formats.sh [vips binary]
set -uo pipefail

vips="${1:-vips}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
assets="$repo/e2e/test-assets/formats"
out="${M0_VIPS_WORK:-/tmp/immich-m0/vips}"
rm -rf "$out" && mkdir -p "$out"

echo "libvips: $("$vips" --version) ($(command -v "$vips"))"
printf '%-6s %-44s %-24s %10s %8s  %s\n' format file loader size ms result
ok=0
bad=0
while IFS= read -r file; do
  rel="${file#"$assets"/}"
  ext="$(printf '%s' "${file##*.}" | tr 'A-Z' 'a-z')"
  name="$(printf '%s' "$rel" | tr '/' '_')"
  loader="$(vipsheader -f vips-loader "$file" 2>/dev/null || echo '-')"
  size="$(vipsheader -f width "$file" 2>/dev/null)x$(vipsheader -f height "$file" 2>/dev/null)"
  start=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
  if "$vips" thumbnail "$file" "$out/$name.preview.jpg[Q=80]" 1440 --size down >"$out/$name.log" 2>&1 &&
    "$vips" thumbnail "$file" "$out/$name.thumb.webp[Q=80]" 250 --size down >>"$out/$name.log" 2>&1; then
    result="ok $(vipsheader -f width "$out/$name.preview.jpg")x$(vipsheader -f height "$out/$name.preview.jpg")"
    ok=$((ok + 1))
  else
    result="FAILED: $(head -1 "$out/$name.log" | cut -c1-80)"
    bad=$((bad + 1))
  fi
  ms=$(($(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000') - start))
  printf '%-6s %-44s %-24s %10s %8s  %s\n' "$ext" "$rel" "$loader" "$size" "$ms" "$result"
done < <(find "$assets" -type f ! -name '.*' ! -iname '*.xmp' ! -iname '*.md' | sort)

echo
echo "Result: $ok decoded, $bad failed. Outputs in $out"
[ "$bad" -eq 0 ]
