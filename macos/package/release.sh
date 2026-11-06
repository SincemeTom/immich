#!/bin/bash
# Makes a release out of its tag, steps 3 to 6 of macos/RELEASING.md: checks out the tag (the uncommitted changes to
# tracked files stashed), builds the signed and notarized .pkg (build-pkg.sh, about 45 minutes), checks it, keeps it
# in macos/package/releases/, and drafts the GitHub release with the version's CHANGELOG.md section and the .sha256.
# Whatever happens, it goes back to the branch it started on and restores the stashed changes.
#
# Usage: macos/package/release.sh v3.3.5-mac.10 [build-pkg.sh options]
#   the log is in macos/package/build/release-<version>-<time>.log
set -euo pipefail

TAG="${1:?usage: macos/package/release.sh v<upstream version>-mac.<n> [build-pkg.sh options]}"
shift

# Checking out the tag may change or remove this file: run from a copy
if [ -z "${IMMICH_RELEASE_REPO:-}" ]; then
  IMMICH_RELEASE_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
  export IMMICH_RELEASE_REPO
  copy="$(mktemp "${TMPDIR:-/tmp}/immich-release.XXXXXX")"
  cp "$0" "$copy"
  exec /bin/bash "$copy" "$TAG" "$@"
fi
REPO="$IMMICH_RELEASE_REPO"
trap 'rm -f "$0"' EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

cd "$REPO"
VERSION="${TAG#v}"
BUILD="$REPO/macos/package/build"
RELEASES="$REPO/macos/package/releases"
PKG="Immich-$VERSION.pkg"
mkdir -p "$BUILD" "$RELEASES"
LOG="$BUILD/release-$VERSION-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

step "Release $TAG"
info "log: $LOG"
case "$TAG" in v*-mac.[0-9]*) ;; *) die "$TAG is not a release tag (v<upstream version>-mac.<n>)" ;; esac
[ "$(git cat-file -t "$TAG" 2>/dev/null)" = tag ] || die "no annotated tag $TAG here (git fetch --tags?)"
git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null || die "$TAG is not on GitHub yet: git push origin $TAG"
grep -q "^## ${TAG}（" macos/CHANGELOG.md || die "macos/CHANGELOG.md has no section for $TAG"
[ ! -e "$RELEASES/$PKG" ] || die "$RELEASES/$PKG is there already: a tag is released once"
command -v gh >/dev/null || die "gh is not installed (brew install gh)"

# The release notes, read now: the tag's CHANGELOG.md may not have the section yet when it was written afterwards
NOTES="$(mktemp "${TMPDIR:-/tmp}/immich-notes.XXXXXX")"
awk -v head="## ${TAG}（" 'index($0, head) == 1 { on = 1; next } on && /^## / { exit } on' macos/CHANGELOG.md \
  | sed -e '/./,$!d' >"$NOTES"
[ -s "$NOTES" ] || die "the $TAG section of macos/CHANGELOG.md is empty"

START="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
STASHED=""
restore() {
  local status=$?
  step "Back to $START"
  git checkout --quiet "$START" || info "could not check out $START: do it by hand"
  if [ -n "$STASHED" ]; then
    git stash pop --quiet && info "restored the stashed changes" || info "could not restore them: git stash list"
  fi
  rm -f "$NOTES" "$0"
  if [ $status -eq 0 ]; then
    printf '\n\033[32mdone\033[0m %s\n' "$TAG"
  else
    printf '\n\033[31mfailed\033[0m (exit %s), see %s\n' "$status" "$LOG"
  fi
}
trap restore EXIT

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  step "Stash the changes to tracked files"
  git status --short --untracked-files=no
  git stash push --quiet --message "release.sh $TAG"
  STASHED=1
fi

step "Check out $TAG"
git checkout --quiet --detach "$TAG"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the checkout is not clean: it would be a development build"
info "$(git log --oneline -1)"

# the Mac is not to sleep while it builds and Apple notarizes
caffeinate -dimsu -w $$ &

step "Build the package (about 45 minutes)"
"$REPO/macos/package/build-pkg.sh" "$@"
[ -f "$BUILD/$PKG" ] || die "build-pkg.sh made no $BUILD/$PKG: was the checkout taken for a development build?"

step "Check it"
cd "$BUILD"
spctl --assess --type install "$PKG"
info "spctl: accepted"
pkgutil --check-signature "$PKG" | sed -n '1,4p'
pkgutil --check-signature "$PKG" | grep -q "trusted by the Apple notary service" || die "$PKG is not notarized"
xcrun stapler validate "$PKG"
shasum -a 256 -c "$PKG.sha256"
info "$(du -h "$PKG" | cut -f1)"
cd "$REPO"

step "Keep it in macos/package/releases/"
cp -c "$BUILD/$PKG" "$BUILD/$PKG.sha256" "$RELEASES/"
cp -cR "$BUILD/sources-$VERSION" "$RELEASES/"
ls -ld "$RELEASES/$PKG" "$RELEASES/$PKG.sha256" "$RELEASES/sources-$VERSION"

step "Draft the GitHub release"
if gh release view "$TAG" --repo SincemeTom/immich >/dev/null 2>&1; then
  info "$TAG has a release already: adding the .sha256 to it"
  gh release upload "$TAG" "$RELEASES/$PKG.sha256" --repo SincemeTom/immich --clobber
else
  gh release create "$TAG" --repo SincemeTom/immich --draft --verify-tag --title "$TAG" \
    --notes-file "$NOTES" "$RELEASES/$PKG.sha256"
fi
info "check the draft and publish it: https://github.com/SincemeTom/immich/releases"
info "then back up $PKG, its .sha256 and sources-$VERSION elsewhere (NAS, cloud), for at least 3 years"
