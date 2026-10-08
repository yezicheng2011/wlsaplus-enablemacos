#!/bin/bash
# Package, sign and archive the macOS release assets (run after npm ci, version:apply, vpn:core, build:web and
# import-codesign-identity.sh):
#   release-assets/WLSAPlus-<v>-mac-arm64.zip     self-update zip, Apple chips   (~half the universal size)
#   release-assets/WLSAPlus-<v>-mac-x64.zip       self-update zip, Intel
#   release-assets/WLSAPlus-<v>-macOS-universal.zip / .dmg   manual first install (Intel + Apple)
#   release-assets/update-manifest.json           Ed25519-signed (WLSAPLUS_UPDATE_ED25519_KEY)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
ARCHES="${WLSAPLUS_ARCHES:-arm64 x64 universal}"
OUT="$ROOT/release-assets"
rm -rf "$OUT" && mkdir -p "$OUT"
unset APPLE_IDENTITY APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID   # forge must not sign; we sign below
manifest_files=()
for arch in $ARCHES; do
  echo "::group::package $arch"
  npx electron-forge package --platform darwin --arch "$arch"
  app="$ROOT/out/WLSAPlus-darwin-$arch/WLSAPlus.app"
  [ -d "$app" ] || { echo "::error::missing $app"; exit 1; }
  bash "$ROOT/scripts/ci/sign-mac-app.sh" "$app" "$VERSION"
  archs="$(lipo -archs "$app/Contents/MacOS/WLSAPlus")"
  case "$arch" in
    arm64) [ "$archs" = "arm64" ] || { echo "::error::arm64 build has $archs"; exit 1; }; name="WLSAPlus-$VERSION-mac-arm64.zip" ;;
    x64) [ "$archs" = "x86_64" ] || { echo "::error::x64 build has $archs"; exit 1; }; name="WLSAPlus-$VERSION-mac-x64.zip" ;;
    universal)
      echo "$archs" | grep -qw x86_64 && echo "$archs" | grep -qw arm64 || { echo "::error::universal build has $archs"; exit 1; }
      name="WLSAPlus-$VERSION-macOS-universal.zip" ;;
  esac
  (cd "$(dirname "$app")" && ditto -c -k --keepParent WLSAPlus.app "$OUT/$name")
  # The zip must round-trip with a valid signature (this is exactly what the updater does).
  check="$(mktemp -d)"; ditto -x -k "$OUT/$name" "$check"; codesign --verify --deep --strict "$check/WLSAPlus.app"; rm -rf "$check"
  manifest_files+=(--file "$arch=$OUT/$name")
  if [ "$arch" = universal ]; then
    stage="$(mktemp -d)"
    ditto "$app" "$stage/WLSAPlus.app"
    ln -s /Applications "$stage/Applications"
    hdiutil create -volname WLSAPlus -srcfolder "$stage" -ov -format UDZO "$OUT/WLSAPlus-$VERSION-macOS-universal.dmg" >/dev/null
    rm -rf "$stage"
  fi
  echo "::endgroup::"
done
NOTES_ARGS=()
[ -n "${WLSAPLUS_RELEASE_NOTES:-}" ] && NOTES_ARGS=(--notes "$WLSAPLUS_RELEASE_NOTES")
node scripts/make-update-manifest.mjs --version "$VERSION" --tag "v$VERSION" --out "$OUT/update-manifest.json" "${manifest_files[@]}" ${NOTES_ARGS[@]+"${NOTES_ARGS[@]}"}
ls -l "$OUT"
(cd "$OUT" && shasum -a 256 *)
