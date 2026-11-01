#!/bin/bash
# Puts the reverse geocoding data in DIR: the files the server reads from build/geodata (cities500.txt,
# admin1CodesASCII.txt, admin2Codes.txt, countryInfo.txt, ne_10m_admin_0_countries.geojson, geodata-date.txt), in
# Chinese, from immich-geodata-cn (https://github.com/ZingLix/immich-geodata-cn, GPL-3.0): GeoNames' places with
# Chinese names, those in China down to the township, so a photo's place reads "上海市 闵行区 江川路街道 / 上海市 / 中国"
# rather than "Jiangchuanlu / Shanghai / China". Its countryInfo.txt has the countries' names in Chinese, which the
# server takes them from.
#
# Usage: macos/native/geodata.sh DIR
#
# Does nothing if DIR has this data already (its source.txt); replaces anything else there (the GeoNames files
# earlier releases had). The server imports the data again when geodata-date.txt changes, at its next start; photos
# already placed keep their names until their metadata is extracted again (Administration > Jobs > Extract
# Metadata > All).
set -euo pipefail

RELEASE=release-2026-08-10
VARIANT=geodata_admin_2_admin_3_admin_4
SHA256=05bcc6d6431601c2a18841d0a5afb6185f235844630559cad9343ba64381513e
URL="https://github.com/ZingLix/immich-geodata-cn/releases/download/$RELEASE/$VARIANT.zip"
SOURCE="immich-geodata-cn $RELEASE $VARIANT"
FILES="cities500.txt admin1CodesASCII.txt admin2Codes.txt countryInfo.txt ne_10m_admin_0_countries.geojson
  geodata-date.txt"

[ $# -eq 1 ] || { echo "usage: $0 DIR" >&2; exit 64; }
dir="${1%/}"

if [ "$(cat "$dir/source.txt" 2>/dev/null)" = "$SOURCE" ] && [ -s "$dir/geodata-date.txt" ]; then
  echo "geodata: $SOURCE, there already"
  exit 0
fi

# beside DIR, so that it is replaced with a rename
mkdir -p "$(dirname "$dir")"
work="$(mktemp -d "$(dirname "$dir")/.geodata.XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "geodata: downloading $URL"
curl -fsSL --retry 3 -o "$work/geodata.zip" "$URL"
if ! echo "$SHA256  $work/geodata.zip" | shasum -a 256 -c --status; then
  echo "geodata: $VARIANT.zip is not the one expected (sha256 $SHA256)" >&2
  exit 1
fi
unzip -q "$work/geodata.zip" -d "$work"
for file in $FILES; do
  [ -s "$work/geodata/$file" ] || { echo "geodata: $VARIANT.zip has no $file" >&2; exit 1; }
done
echo "$SOURCE" >"$work/geodata/source.txt"

if [ -e "$dir" ] || [ -L "$dir" ]; then
  mv "$dir" "$work/previous"
fi
mv "$work/geodata" "$dir"
echo "geodata: $SOURCE, dated $(cat "$dir/geodata-date.txt")"
