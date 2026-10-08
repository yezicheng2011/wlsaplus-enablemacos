#!/bin/bash
# Sign one WLSAPlus.app with the fixed self-signed identity and verify it (signature, designated requirement
# pinned to our certificate, Info.plist version).   sign-mac-app.sh /path/WLSAPlus.app [expected-version]
set -euo pipefail
APP="$1"; EXPECTED="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${WLSAPLUS_CODESIGN_IDENTITY:?run import-codesign-identity.sh first}"
REQ="$(node -p "require('$ROOT/electron/update-config.cjs').CODESIGN_REQUIREMENT")"
xattr -cr "$APP"
codesign --force --deep --timestamp=none --sign "$WLSAPLUS_CODESIGN_IDENTITY" \
  ${WLSAPLUS_CODESIGN_KEYCHAIN:+--keychain "$WLSAPLUS_CODESIGN_KEYCHAIN"} \
  --entitlements "$ROOT/electron/entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"
codesign --verify -R="$REQ" "$APP"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /designated requirement: /p'
if [ -n "$EXPECTED" ]; then
  got="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
  [ "$got" = "$EXPECTED" ] || { echo "::error::$APP has version $got, expected $EXPECTED"; exit 1; }
fi
echo "signed + verified: $APP ($(lipo -archs "$APP/Contents/MacOS/WLSAPlus"))"
