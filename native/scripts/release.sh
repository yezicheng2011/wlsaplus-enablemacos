#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WLSAPLUS_VERSION:?Set WLSAPLUS_VERSION}"
: "${WLSAPLUS_UPDATE_ED25519_KEY:?Use the existing update key}"
export WLSAPLUS_SIGN_IDENTITY='764D4389AAFA0C50311E39C17DDFA1981ABEF86C'
: "${WLSAPLUS_SIGN_IDENTITY:?A release installer requires WLSAPLUS_SIGN_IDENTITY}"
[[ "$WLSAPLUS_SIGN_IDENTITY" != "-" ]] || { echo 'A release installer cannot be ad-hoc signed.' >&2; exit 1; }
bash scripts/test.sh
bash scripts/build.sh
app='out/WLSAPlus.app'
/usr/bin/codesign --verify -R='identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"764D4389AAFA0C50311E39C17DDFA1981ABEF86C"' "$app"
rm -rf release-assets
mkdir -p release-assets
for pair in arm64:arm64 x64:x86_64; do
  name="${pair%%:*}"; arch="${pair#*:}"
  stage=".build/release-$name"
  rm -rf "$stage"
  mkdir -p "$stage"
  # ditto then lipo invalidate the previous seal; re-sign deep AFTER thinning.
  COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn "$app" "$stage/WLSAPlus.app"
  xcrun lipo "$stage/WLSAPlus.app/Contents/MacOS/WLSAPlus" -thin "$arch" -output "$stage/WLSAPlus.app/Contents/MacOS/WLSAPlus"
  /usr/bin/codesign --force --deep --sign "$WLSAPLUS_SIGN_IDENTITY" --timestamp=none "$stage/WLSAPlus.app"
  /usr/bin/codesign --verify --deep --strict "$stage/WLSAPlus.app"
  echo "arch $name codesign verify --deep --strict: OK"
  if command -v spctl >/dev/null 2>&1; then
    set +e
    spctl_out="$(/usr/sbin/spctl -a -vv --type execute "$stage/WLSAPlus.app" 2>&1)"
    spctl_status=$?
    set -e
    echo "arch $name spctl -a -vv:"
    printf '%s\n' "$spctl_out"
    echo "arch $name spctl exit status: $spctl_status"
  fi
  COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$stage/WLSAPlus.app" "release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-$name.zip"
  "$app/Contents/MacOS/WLSAPlus" --validate-archive "release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-$name.zip"
done
# Universal zip from the already-signed app; do not mutate Contents after this.
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$app" "release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.zip"
/usr/bin/codesign --verify --deep --strict "$app"
rm -rf .build/dmg
mkdir -p .build/dmg
# Preserve signature into the DMG staging copy (no post-copy Content edits).
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn "$app" .build/dmg/WLSAPlus.app
/usr/bin/codesign --verify --deep --strict .build/dmg/WLSAPlus.app
ln -sfn /Applications .build/dmg/Applications
/usr/bin/hdiutil create -volname WLSAPlus -srcfolder .build/dmg -ov -format UDZO "release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.dmg"
# Official download. build.sh already signed this pkg from the sealed universal app.
cp "out/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.pkg" "release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.pkg"
/usr/sbin/pkgutil --check-signature "release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.pkg"
/usr/bin/codesign --verify --deep --strict "$app"
"$app/Contents/MacOS/WLSAPlus" --make-manifest --version "$WLSAPLUS_VERSION" --tag "v$WLSAPLUS_VERSION" --out release-assets/update-manifest.json \
  --file "arm64=release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-arm64.zip" \
  --file "x64=release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-x64.zip" \
  --file "universal=release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.zip"
echo 'Release assets are prepared locally. Publishing requires a separate release action.'
