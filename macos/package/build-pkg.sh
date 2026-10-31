#!/bin/bash
# Builds the Immich .pkg: a self-contained release (build-release.sh) and the machine learning models the server's
# defaults name, every Mach-O file signed with Developer ID under the hardened runtime, then the package signed,
# notarized by Apple and stapled. Installing it puts the payload in /Library/Application Support/Immich/pkg, and its
# postinstall hands it to the user logged in and configures Immich for them (scripts/postinstall).
#
# Usage: macos/package/build-pkg.sh [options]
#   --release DIR        package this release instead of building one
#   --models DIR         take the models from here where they match (default: the install's on this Mac);
#                        whatever is missing is downloaded from Hugging Face
#   --identity NAME      Developer ID Application identity (default: the first in the keychain)
#   --installer NAME     Developer ID Installer identity (default: the first in the keychain)
#   --notary-profile P   notarytool keychain profile (default: immich-notary)
#   --no-notarize        sign, but do not notarize or staple
#   --out DIR            default: macos/package/build
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/macos/package"
IDENTIFIER=io.github.sincemetom.immich
STAGE_PATH="Library/Application Support/Immich/pkg"

opt_release="" models="$HOME/Library/Application Support/Immich/data/models" identity="" installer=""
profile=immich-notary notarize=1 OUT="$HERE/build"
while [ $# -gt 0 ]; do
  case "$1" in
    --release) opt_release="$2"; shift ;;
    --models) models="$2"; shift ;;
    --identity) identity="$2"; shift ;;
    --installer) installer="$2"; shift ;;
    --notary-profile) profile="$2"; shift ;;
    --no-notarize) notarize="" ;;
    --out) OUT="$2"; shift ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

first_identity() { security find-identity -v -p basic | sed -n "s/.*\"\($1: .*\)\"/\1/p" | head -1; }
identity="${identity:-$(first_identity "Developer ID Application")}"
installer="${installer:-$(first_identity "Developer ID Installer")}"
[ -n "$identity" ] || die "no Developer ID Application identity in the keychain"
[ -n "$installer" ] || die "no Developer ID Installer identity in the keychain"
if [ -n "$notarize" ]; then
  xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 \
    || die "no notarytool profile $profile: xcrun notarytool store-credentials $profile --apple-id ... --team-id ..."
fi

# --- release -----------------------------------------------------------------------------------------------------

if [ -n "$opt_release" ]; then
  release="$(cd "$opt_release" && pwd)"
else
  # it prints the release folder last
  release="$("$HERE/build-release.sh" --out "$OUT" | tee /dev/stderr | tail -n 1)"
fi
if [ ! -f "$release/.complete" ] || ! grep -q '^standalone=1' "$release/RELEASE"; then
  die "$release is not a self-contained release"
fi
RELEASE_ID="$(sed -n 's/^id=//p' "$release/RELEASE")"
VERSION="$(sed -n 's/^version=//p' "$release/RELEASE")"
TAG="$(sed -n 's/^tag=//p' "$release/RELEASE")"
COMMIT="$(sed -n 's/^commit=//p' "$release/RELEASE" | cut -c1-9)"
if [ -n "$TAG" ]; then
  # v3.3.5-mac.2: shown as 3.3.5-mac.2, and to Installer as 3.3.5.2, which orders releases
  DISPLAY_VERSION="${TAG#v}"
  PKG_VERSION="$VERSION.${TAG##*-mac.}"
  PKG_NAME="Immich-$DISPLAY_VERSION.pkg"
else
  DISPLAY_VERSION="$VERSION-dev+$COMMIT"
  PKG_VERSION="$VERSION.0"
  PKG_NAME="Immich-$VERSION-dev-$COMMIT.pkg"
fi
MACOS_MIN="$(sed -n 's/^macos_min=//p' "$release/RELEASE")"
MACOS_MIN="${MACOS_MIN:-15.0}"

WORK="$OUT/pkg-$RELEASE_ID"
ROOT="$WORK/root"
PAYLOAD="$ROOT/$STAGE_PATH/$RELEASE_ID"
rm -rf "$WORK"
mkdir -p "$PAYLOAD" "$WORK/components" "$WORK/scripts" "$WORK/resources"

step "Payload: release $RELEASE_ID"
# a clone (APFS: no space), so that the release itself stays unsigned and can be packaged again
cp -cR "$release" "$PAYLOAD/release"
info "$(du -sh "$PAYLOAD/release" | awk '{ print $1 }')"

step "Payload: machine learning models"
# what a new install uses: configure.sh's smart search model (the server's own default understands only English), the
# server's defaults for faces and text
read -r face ocr <<<"$(cd "$release/server" && "$release/node/bin/node" --input-type=module -e "
  const { defaults } = await import('$release/server/dist/dtos/config.dto.js');
  console.log(defaults.machineLearning.facialRecognition.modelName, defaults.machineLearning.ocr.modelName);")"
clip="$(sed -n 's/^DEFAULT_CLIP_MODEL=//p' "$release/native/configure.sh")"
[ -n "$clip" ] && [ -n "$face" ] && [ -n "$ocr" ] || die "cannot tell which models a new install uses"
info "smart search $clip, faces $face, text $ocr"
PYTHONPATH="$release/ml" PYTHONDONTWRITEBYTECODE=1 MACHINE_LEARNING_CACHE_FOLDER="$PAYLOAD/models" \
  "$release/ml/python/bin/python3" "$HERE/stage_models.py" "$models" "$PAYLOAD/models" "$clip" "$face" "$ocr"

# --- signing -----------------------------------------------------------------------------------------------------

step "Signing every Mach-O file ($identity)"
python3 - "$PAYLOAD/release" >"$WORK/macho.txt" <<'PY'
import sys
from pathlib import Path
magic = {b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
for p in sorted(Path(sys.argv[1]).rglob("*")):
    if p.is_file() and not p.is_symlink():
        with p.open("rb") as f:
            if f.read(4) in magic:
                print(p)
PY
info "$(wc -l <"$WORK/macho.txt" | tr -d ' ') files"
node_bin="$PAYLOAD/release/node/bin/node"
grep -vxF "$node_bin" "$WORK/macho.txt" | tr '\n' '\0' \
  | xargs -0 -n 16 -P 8 codesign --force --options runtime --timestamp --sign "$identity" >"$WORK/codesign.log" 2>&1 \
  || { tail -n 20 "$WORK/codesign.log" >&2; die "signing failed"; }
codesign --force --options runtime --timestamp --entitlements "$HERE/entitlements/node.plist" --sign "$identity" "$node_bin"

step "Checking the signed release, with Homebrew out of reach"
"$HERE/check-release.sh" "$PAYLOAD/release" --signed | sed 's/^/    /'
[ "${PIPESTATUS[0]}" -eq 0 ] || die "the signed release does not pass its check"

# --- package -----------------------------------------------------------------------------------------------------

payload_kb="$(du -sk "$ROOT" | awk '{ print $1 }')"
# the payload, and what preparing the models adds (CoreML's compiled copies, about 10 GB for the default models)
size_gb=$(( (payload_kb / 1048576) + 11 ))

step "Package"
sed "s/@RELEASE_ID@/$RELEASE_ID/" "$HERE/scripts/postinstall" >"$WORK/scripts/postinstall"
chmod 755 "$WORK/scripts/postinstall"
for lang in zh_CN en; do
  mkdir -p "$WORK/resources/$lang.lproj"
  for page in welcome conclusion; do
    sed -e "s/@VERSION@/$DISPLAY_VERSION/g" -e "s/@SIZE_GB@/$size_gb/g" -e "s/@MACOS_MIN@/$MACOS_MIN/g" \
      "$HERE/resources/$lang.lproj/$page.html" >"$WORK/resources/$lang.lproj/$page.html"
  done
done
# nothing in the payload is to be moved to where Installer finds another copy of it
pkgbuild --analyze --root "$ROOT" "$WORK/component.plist" >/dev/null
count="$(/usr/libexec/PlistBuddy -c "Print" "$WORK/component.plist" | grep -c "RootRelativeBundlePath" || true)"
for ((i = 0; i < count; i++)); do
  /usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" "$WORK/component.plist"
done
component="immich-$VERSION.pkg"
pkgbuild --root "$ROOT" --component-plist "$WORK/component.plist" --scripts "$WORK/scripts" \
  --identifier "$IDENTIFIER" --version "$PKG_VERSION" --install-location / --ownership recommended \
  "$WORK/components/$component" | sed 's/^/    /'
sed -e "s/@IDENTIFIER@/$IDENTIFIER/g" -e "s/@VERSION@/$PKG_VERSION/g" -e "s/@COMPONENT@/$component/g" \
  -e "s/<os-version min=\"[0-9.]*\"\/>/<os-version min=\"$MACOS_MIN\"\/>/" \
  "$HERE/distribution.xml" >"$WORK/distribution.xml"
PKG="$OUT/$PKG_NAME"
rm -f "$PKG"
productbuild --distribution "$WORK/distribution.xml" --resources "$WORK/resources" --package-path "$WORK/components" \
  --sign "$installer" --timestamp "$PKG" | sed 's/^/    /'
rm -rf "$WORK/components"
info "$PKG: $(du -h "$PKG" | awk '{ print $1 }'), installs $((payload_kb / 1048576)) GB, for macOS $MACOS_MIN or later"

# --- notarization ------------------------------------------------------------------------------------------------

if [ -n "$notarize" ]; then
  step "Notarizing (uploads $(du -h "$PKG" | awk '{ print $1 }'), then Apple checks it)"
  xcrun notarytool submit "$PKG" --keychain-profile "$profile" --wait --timeout 4h --output-format json \
    >"$WORK/notary.json" || true
  id="$(plutil -extract id raw "$WORK/notary.json" 2>/dev/null || true)"
  status="$(plutil -extract status raw "$WORK/notary.json" 2>/dev/null || true)"
  info "submission $id: ${status:-no answer}"
  if [ -n "$id" ]; then
    xcrun notarytool log "$id" --keychain-profile "$profile" "$WORK/notary-log.json" >/dev/null 2>&1 || true
  fi
  if [ "$status" != Accepted ]; then
    [ -f "$WORK/notary-log.json" ] && python3 -c "
import json, sys
log = json.load(open(sys.argv[1]))
for issue in (log.get('issues') or [])[:30]:
    print('   ', issue.get('severity'), issue.get('path'), '-', issue.get('message'))" "$WORK/notary-log.json"
    die "notarization: ${status:-failed}, see $WORK/notary.json"
  fi
  xcrun stapler staple "$PKG" | tail -n 1 | sed 's/^/    /'
fi

shasum -a 256 "$PKG" | sed "s#  .*/#  #" >"$PKG.sha256"
if [ -n "$TAG" ] && [ -n "$notarize" ]; then
  # kept apart from the build folder, which a later build may clear
  mkdir -p "$HERE/releases"
  cp -c "$PKG" "$PKG.sha256" "$HERE/releases/"
fi

step "Checks"
pkgutil --check-signature "$PKG" | sed -n '1,4p' | sed 's/^/    /'
if [ -n "$notarize" ]; then
  spctl --assess --type install -vv "$PKG" 2>&1 | sed 's/^/    /'
fi
echo
echo "$PKG"
