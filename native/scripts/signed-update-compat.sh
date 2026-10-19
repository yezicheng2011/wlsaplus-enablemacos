#!/bin/bash
# Opt-in test oracle only. Never publishes, installs dependencies, or modifies
# the original Electron updater. Signing material stays in an ephemeral keychain.
set +x
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${WLSAPLUS_RUN_SIGNED_COMPAT_SMOKE:-0}" != 1 ]]; then
  echo 'SKIP signed compatibility smoke: set WLSAPLUS_RUN_SIGNED_COMPAT_SMOKE=1 to opt in.'
  exit 0
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'SKIP signed compatibility smoke: macOS is required for real code-signing and bundle tools.'
  exit 0
fi
for setting in WLSAPLUS_CODESIGN_P12_BASE64 WLSAPLUS_CODESIGN_P12_PASSWORD WLSAPLUS_UPDATE_ED25519_KEY; do
  if [[ -z "${!setting:-}" ]]; then
    echo "SKIP signed compatibility smoke: required signing secret $setting is unavailable."
    exit 0
  fi
done
legacy="${WLSAPLUS_LEGACY_ELECTRON_DIR:-../electron}"
app="${WLSAPLUS_NATIVE_APP:-out/WLSAPlus.app}"
[[ -f "$legacy/mac-updater.cjs" && -f "$legacy/update-helper.sh" ]] || { echo 'Original Electron updater test oracle was not found.' >&2; exit 1; }
[[ -x "$app/Contents/MacOS/WLSAPlus" ]] || { echo 'Build the native universal app before the signed compatibility smoke.' >&2; exit 1; }
if [[ "${WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE:-0}" == 1 ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && -d "${RUNNER_TEMP:-}" ]] || {
    echo 'Helper launch smoke is permitted only on an ephemeral GitHub-hosted runner.' >&2; exit 1;
  }
fi
base="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
smoke_tmp="$(mktemp -d "$base/wlsaplus-signed-compat.XXXXXX")"
smoke_keychain="$smoke_tmp/signing.keychain-db"
cleanup() {
  /usr/bin/security delete-keychain "$smoke_keychain" >/dev/null 2>&1 || true
  rm -rf "$smoke_tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
printf '%s' "$WLSAPLUS_CODESIGN_P12_BASE64" | /usr/bin/base64 -D > "$smoke_tmp/signing.p12"
smoke_password="$(/usr/bin/uuidgen)"
/usr/bin/security create-keychain -p "$smoke_password" "$smoke_keychain" >/dev/null
/usr/bin/security unlock-keychain -p "$smoke_password" "$smoke_keychain" >/dev/null
/usr/bin/security set-keychain-settings -lut 1200 "$smoke_keychain" >/dev/null
/usr/bin/security import "$smoke_tmp/signing.p12" -k "$smoke_keychain" -P "$WLSAPLUS_CODESIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null 2>&1 || {
  echo 'Could not import the pinned signing identity into the temporary keychain.' >&2; exit 1;
}
/usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$smoke_password" "$smoke_keychain" >/dev/null 2>&1
rm -f "$smoke_tmp/signing.p12"
identity='764D4389AAFA0C50311E39C17DDFA1981ABEF86C'
requirement='identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"764D4389AAFA0C50311E39C17DDFA1981ABEF86C"'
version=2.0.0
mkdir -p "$smoke_tmp/package" "$smoke_tmp/installed"
new_app="$smoke_tmp/package/WLSAPlus.app"
old_app="$smoke_tmp/installed/WLSAPlus.app"
/usr/bin/ditto "$app" "$new_app"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$new_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$new_app/Contents/Info.plist"
/usr/bin/codesign --force --sign "$identity" --keychain "$smoke_keychain" --timestamp=none "$new_app" >/dev/null 2>&1
/usr/bin/codesign --verify --deep --strict "$new_app"
/usr/bin/codesign --verify "-R=$requirement" "$new_app"
/usr/bin/lipo "$new_app/Contents/MacOS/WLSAPlus" -verify_arch arm64 x86_64
# A throwaway trusted target represents the old installed bundle. This is a
# native binary stamped 1.1.2, not an original Electron binary.
/usr/bin/ditto "$new_app" "$old_app"
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 1.1.2' "$old_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 1.1.2' "$old_app/Contents/Info.plist"
/usr/bin/codesign --force --sign "$identity" --keychain "$smoke_keychain" --timestamp=none "$old_app" >/dev/null 2>&1
archive="$smoke_tmp/WLSAPlus-$version-macOS-universal.zip"
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$new_app" "$archive"
"$new_app/Contents/MacOS/WLSAPlus" --validate-archive "$archive"
"$new_app/Contents/MacOS/WLSAPlus" --make-manifest --version "$version" --tag "v$version" --out "$smoke_tmp/update-manifest.json" --file "universal=$archive"
# The child test only consumes the public signature; don't propagate secrets.
unset WLSAPLUS_CODESIGN_P12_BASE64 WLSAPLUS_CODESIGN_P12_PASSWORD WLSAPLUS_UPDATE_ED25519_KEY
node Tests/signed-update-compat.mjs "$smoke_tmp" "$legacy" "$old_app" "$smoke_tmp/update-manifest.json" "$archive" "$version"
echo 'PASS signed compatibility smoke: unchanged 1.1.2 updater accepted the native package using the pinned release trust.'
echo 'Scope: real updater staging/tools and optional helper startup; no original Electron runtime or public release was executed.'
