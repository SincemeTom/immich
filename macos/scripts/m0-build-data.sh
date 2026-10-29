#!/usr/bin/env bash
# M0: assembles what the container keeps under /build (IMMICH_BUILD_DATA) for a native server: geodata, as
# immich-app/base-images server/Dockerfile downloads it, and the web build. Plugins are left out of M0.
# Usage: macos/scripts/m0-build-data.sh [target dir]
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
target="${1:-$HOME/Library/Caches/immich-m0/build}"
geodata="$target/geodata"
mkdir -p "$geodata"

if [ ! -s "$geodata/geodata-date.txt" ]; then
  echo "downloading geodata to $geodata"
  cd "$geodata"
  curl -fsSLO https://download.geonames.org/export/dump/cities500.zip
  for file in admin1CodesASCII.txt admin2Codes.txt countryInfo.txt; do
    curl -fsSLO "https://download.geonames.org/export/dump/$file"
  done
  curl -fsSLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson
  unzip -oq cities500.zip && rm cities500.zip
  chmod 444 ./*.txt ./*.geojson
  # the server only compares this to what it imported last; the container writes GNU date's --iso-8601=seconds
  date -u +%Y-%m-%dT%H:%M:%S+00:00 | tr -d '\n' >geodata-date.txt
fi

if [ ! -s "$target/www/index.html" ]; then
  if [ -s "$repo/web/build/index.html" ]; then
    rm -rf "$target/www" && cp -R "$repo/web/build" "$target/www"
  else
    echo "no web build: run 'pnpm --filter immich-web build' to serve the web UI; the API works without it" >&2
  fi
fi

ls -la "$geodata"
