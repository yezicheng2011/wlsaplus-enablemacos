#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WLSAPLUS_VERSION:?Set WLSAPLUS_VERSION}"
: "${WLSAPLUS_UPDATE_ED25519_KEY:?Use the existing update key}"
export WLSAPLUS_SIGN_IDENTITY='764D4389AAFA0C50311E39C17DDFA1981ABEF86C'
bash scripts/test.sh
bash scripts/build.sh
app='out/WLSAPlus.app'
/usr/bin/codesign --verify -R='identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"764D4389AAFA0C50311E39C17DDFA1981ABEF86C"' "$app"
mkdir -p release-assets
for pair in arm64:arm64 x64:x86_64; do
  name="${pair%%:*}"; arch="${pair#*:}"
  stage=".build/release-$name"
  mkdir -p "$stage"
  /usr/bin/ditto "$app" "$stage/WLSAPlus.app"
  xcrun lipo "$stage/WLSAPlus.app/Contents/MacOS/WLSAPlus" -thin "$arch" -output "$stage/WLSAPlus.app/Contents/MacOS/WLSAPlus"
  /usr/bin/codesign --force --sign "$WLSAPLUS_SIGN_IDENTITY" --timestamp=none "$stage/WLSAPlus.app"
  COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$stage/WLSAPlus.app" "release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-$name.zip"
done
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$app" "release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.zip"
/usr/bin/hdiutil create -volname WLSAPlus -srcfolder "$app" -ov -format UDZO "release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.dmg"
"$app/Contents/MacOS/WLSAPlus" --make-manifest --version "$WLSAPLUS_VERSION" --tag "v$WLSAPLUS_VERSION" --out release-assets/update-manifest.json \
  --file "arm64=release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-arm64.zip" \
  --file "x64=release-assets/WLSAPlus-$WLSAPLUS_VERSION-mac-x64.zip" \
  --file "universal=release-assets/WLSAPlus-$WLSAPLUS_VERSION-macOS-universal.zip"
echo 'Release assets are prepared locally. Publishing requires a separate release action.'
