#!/usr/bin/env bash
# M0: runs macos/scripts/m0-sharp-probe.spec.ts with the server's own vitest setup. The probe is copied into server/ for
# the run (the server's module resolution and path aliases only apply there) and removed afterwards.
# Usage: macos/scripts/m0-sharp-probe.sh
set -uo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
probe="$repo/server/src/m0-sharp-probe.spec.ts"
trap 'rm -f "$probe"' EXIT
cp "$repo/macos/scripts/m0-sharp-probe.spec.ts" "$probe"
cd "$repo/server"
pnpm --config.verify-deps-before-run=false exec vitest run --config test/vitest.config.mjs \
  --testTimeout 60000 src/m0-sharp-probe.spec.ts
