#!/usr/bin/env bash
# M0: checks that the toolchain needed for a native Apple Silicon deployment is present and arm64.
# Usage: macos/scripts/m0-check-env.sh
set -uo pipefail

pass=0
warn=0
fail=0

ok() { printf '  \033[32m[ OK ]\033[0m %s\n' "$1"; pass=$((pass + 1)); }
wn() { printf '  \033[33m[WARN]\033[0m %s\n' "$1"; warn=$((warn + 1)); }
ko() { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# prints the architectures of a binary on PATH, or "script" when it is not Mach-O
binary_arch() {
  local path
  path="$(command -v "$1" 2>/dev/null)" || return 1
  path="$(readlink -f "$path")"
  if file -b "$path" | grep -q 'Mach-O'; then
    lipo -archs "$path" 2>/dev/null
  else
    echo "script"
  fi
}

check_tool() {
  local name="$1" hint="$2" arch
  if ! arch="$(binary_arch "$name")"; then
    ko "$name: missing ($hint)"
    return
  fi
  case "$arch" in
    *arm64*) ok "$name: $(command -v "$name") [$arch]" ;;
    script) ok "$name: $(command -v "$name") [script]" ;;
    *) ko "$name: $(command -v "$name") is $arch, needs arm64 ($hint)" ;;
  esac
}

echo "== Machine"
machine="$(uname -m)"
if [ "$machine" = "arm64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" != "1" ]; then
  ok "$(sysctl -n machdep.cpu.brand_string), $(sw_vers -productVersion), shell runs natively"
else
  ko "shell is not running natively on arm64 (uname -m: $machine)"
fi
mem_gb=$(($(sysctl -n hw.memsize) / 1073741824))
[ "$mem_gb" -ge 16 ] && ok "memory: ${mem_gb} GB" || wn "memory: ${mem_gb} GB (16 GB+ recommended)"
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "$free_gb" -ge 50 ] && ok "free disk: ${free_gb} GB" || wn "free disk: ${free_gb} GB (50 GB+ recommended for building)"

echo "== Homebrew"
if [ -x /opt/homebrew/bin/brew ]; then
  ok "arm64 Homebrew at /opt/homebrew"
else
  ko "arm64 Homebrew missing at /opt/homebrew (install from https://brew.sh in a native terminal)"
fi
if [ -x /usr/local/bin/brew ]; then
  wn "Intel Homebrew at /usr/local: keep /opt/homebrew/bin ahead of it in PATH"
fi

echo "== Build toolchain"
xcode-select -p >/dev/null 2>&1 && ok "Xcode tools: $(xcode-select -p)" || ko "Xcode command line tools missing (xcode-select --install)"
check_tool uv "curl -LsSf https://astral.sh/uv/install.sh | sh"
check_tool node "brew install node@24"
check_tool pnpm "corepack enable pnpm"
check_tool cargo "rustup, needed to build VectorChord"
check_tool pkg-config "brew install pkg-config"

echo "== Runtime dependencies"
check_tool postgres "brew install postgresql@17"
check_tool pg_dump "brew install postgresql@17"
check_tool valkey-server "brew install valkey"
check_tool vips "brew install vips"
check_tool ffmpeg "jellyfin-ffmpeg, see M0 report"
check_tool exiftool "brew install exiftool"

if command -v ffmpeg >/dev/null 2>&1; then
  echo "== ffmpeg capabilities"
  encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
  filters="$(ffmpeg -hide_banner -filters 2>/dev/null)"
  for enc in h264_videotoolbox hevc_videotoolbox libx264 libx265 libsvtav1 libvpx-vp9; do
    grep -q " $enc " <<<"$encoders" && ok "encoder $enc" || wn "encoder $enc missing"
  done
  for flt in tonemapx scale_vt tonemap_videotoolbox zscale; do
    grep -q " $flt " <<<"$filters" && ok "filter $flt" || wn "filter $flt missing"
  done
fi

if command -v vips >/dev/null 2>&1; then
  echo "== libvips formats"
  loaders="$(vips -l foreign 2>/dev/null)"
  # dcraw is libvips' name for its libraw-based camera RAW loader
  for fmt in heif jxl dcraw webp tiff; do
    grep -qi "${fmt}load" <<<"$loaders" && ok "loader $fmt" || wn "loader $fmt missing"
  done
fi

echo
echo "Result: ${pass} ok, ${warn} warnings, ${fail} failures"
[ "$fail" -eq 0 ]
