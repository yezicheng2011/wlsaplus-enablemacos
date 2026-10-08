#!/bin/bash
# CI only (GitHub macOS runner): import the fixed self-signed "WLSAPlus Self-Signed Code Signing" identity from
# secrets into a throw-away keychain, trust it for code signing, and export WLSAPLUS_CODESIGN_IDENTITY (SHA-1)
# and WLSAPLUS_CODESIGN_KEYCHAIN to $GITHUB_ENV. Never prints secret material.
#   env: WLSAPLUS_CODESIGN_P12_BASE64, WLSAPLUS_CODESIGN_P12_PASSWORD
set -euo pipefail
: "${WLSAPLUS_CODESIGN_P12_BASE64:?missing secret WLSAPLUS_CODESIGN_P12_BASE64}"
: "${WLSAPLUS_CODESIGN_P12_PASSWORD:?missing secret WLSAPLUS_CODESIGN_P12_PASSWORD}"
RUNNER_TMP="${RUNNER_TEMP:-$(mktemp -d)}"
KC="$RUNNER_TMP/wlsaplus-codesign.keychain-db"
KC_PASS="$(uuidgen)"
P12="$RUNNER_TMP/wlsaplus-codesign.p12"
CERT="$RUNNER_TMP/wlsaplus-codesign.cer"
umask 077
printf '%s' "$WLSAPLUS_CODESIGN_P12_BASE64" | base64 --decode > "$P12"
security create-keychain -p "$KC_PASS" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KC_PASS" "$KC"
security import "$P12" -k "$KC" -P "$WLSAPLUS_CODESIGN_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KC" >/dev/null
# Put the keychain in the search list (keep the login keychain) so codesign can find the identity.
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
# Trust the self-signed certificate for code signing on this runner (codesign refuses untrusted identities).
security find-certificate -c "WLSAPlus Self-Signed Code Signing" -p "$KC" > "$CERT"
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$CERT"
rm -f "$P12"
IDENTITY="$(security find-identity -v -p codesigning "$KC" | awk '/WLSAPlus Self-Signed Code Signing/ {print $2; exit}')"
if [ -z "$IDENTITY" ]; then
  echo "valid identities:"; security find-identity -p codesigning "$KC" || true
  echo "::error::WLSAPlus self-signed identity not usable for code signing"; exit 1
fi
echo "Code signing identity: $IDENTITY"
{
  echo "WLSAPLUS_CODESIGN_IDENTITY=$IDENTITY"
  echo "WLSAPLUS_CODESIGN_KEYCHAIN=$KC"
} >> "${GITHUB_ENV:-/dev/null}"
