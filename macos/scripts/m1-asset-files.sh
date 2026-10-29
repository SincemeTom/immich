#!/bin/bash
# M1: where an asset's files are and whether they exist, and how many visible assets have a search embedding.
# Usage: macos/scripts/m1-asset-files.sh <immichctl> <original file name>
set -euo pipefail
ctl="$1"
name="$2"
"$ctl" psql -At -F '|' -v name="$name" <<'SQL' | while IFS='|' read -r kind file; do
SELECT 'original', "originalPath" FROM asset WHERE "originalFileName" = :'name'
UNION ALL
SELECT f.type::text, f.path FROM asset a JOIN asset_file f ON f."assetId" = a.id WHERE a."originalFileName" = :'name';
SQL
  if [ -e "$file" ]; then echo "$name $kind: exists"; else echo "$name $kind: MISSING ($file)"; fi
done
"$ctl" psql -At <<'SQL'
SELECT count(*) || ' visible assets, ' || (SELECT count(*) FROM smart_search) || ' with a search embedding'
FROM asset WHERE "deletedAt" IS NULL AND visibility <> 'hidden';
SQL
