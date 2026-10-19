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
smoke_phase='temporary signing setup'
smoke_trust_added=0
smoke_system_certificate_added=0
smoke_searchlist_changed=0
smoke_original_keychains=()
smoke_original_keychain_count=0
identity='764D4389AAFA0C50311E39C17DDFA1981ABEF86C'
smoke_diagnostics="$smoke_tmp/signing-diagnostics.log"
mark() { smoke_phase="$1"; printf 'Signed compatibility smoke: %s.\n' "$smoke_phase"; }
bounded() {
  # macOS ships no timeout(1). Node is already required by this oracle. Never
  # print an exception or argv: import/keychain commands contain passwords.
  node - "$@" <<'NODE'
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.argv[2], process.argv.slice(3), {
  timeout: 30_000, killSignal: 'SIGKILL', stdio: 'inherit',
});
if (result.error || result.signal) {
  process.stderr.write(result.error?.code === 'ETIMEDOUT'
    ? 'Signing test system command exceeded its 30-second limit.\n'
    : 'Signing test system command could not complete.\n');
  process.exit(1);
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
NODE
}
failed() {
  printf 'FAIL signed compatibility smoke during %s.\n' "$smoke_phase" >&2
  if [[ -f "$smoke_diagnostics" ]]; then
    # Emit only OS status/error lines, never imported objects or key material.
    /usr/bin/grep -Ei 'security:|codesign:|errSec|CSSMERR|user interaction|item could not be found|identity not found|no identity|failed|Signing test system command' "$smoke_diagnostics" | /usr/bin/tail -n 8 >&2 || true
  fi
}
cleanup() {
  if [[ "$smoke_trust_added" == 1 ]]; then
    bounded sudo -n /usr/bin/security remove-trusted-cert -d "$smoke_tmp/pinned-certificate.pem" >/dev/null 2>&1 || echo 'Warning: hosted-runner temporary certificate trust cleanup failed.' >&2
  fi
  if [[ "$smoke_system_certificate_added" == 1 ]]; then
    bounded sudo -n /usr/bin/security delete-certificate -Z "$identity" /Library/Keychains/System.keychain >/dev/null 2>&1 || echo 'Warning: hosted-runner temporary certificate cleanup failed.' >&2
  fi
  if [[ "$smoke_searchlist_changed" == 1 ]]; then
    if [[ "$smoke_original_keychain_count" -gt 0 ]]; then
      bounded /usr/bin/security list-keychains -d user -s "${smoke_original_keychains[@]}" >/dev/null 2>&1 || echo 'Warning: temporary keychain search-list cleanup failed.' >&2
    else
      bounded /usr/bin/security list-keychains -d user -s >/dev/null 2>&1 || echo 'Warning: temporary keychain search-list cleanup failed.' >&2
    fi
  fi
  bounded /usr/bin/security delete-keychain "$smoke_keychain" >/dev/null 2>&1 || true
  rm -rf "$smoke_tmp"
}
trap cleanup EXIT
trap failed ERR
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
mark 'preparing the temporary keychain'
printf '%s' "$WLSAPLUS_CODESIGN_P12_BASE64" | /usr/bin/base64 -D > "$smoke_tmp/signing.p12"
smoke_password="$(/usr/bin/uuidgen)"
bounded /usr/bin/security create-keychain -p "$smoke_password" "$smoke_keychain" >/dev/null
bounded /usr/bin/security unlock-keychain -p "$smoke_password" "$smoke_keychain" >/dev/null
bounded /usr/bin/security set-keychain-settings -lut 1200 "$smoke_keychain" >/dev/null
bounded /usr/bin/security list-keychains -d user > "$smoke_tmp/original-keychains.txt" 2>"$smoke_diagnostics"
smoke_keychain_pattern='^[[:space:]]*"([^"]*)"[[:space:]]*$'
while IFS= read -r smoke_keychain_line; do
  [[ -n "$smoke_keychain_line" ]] || continue
  [[ "$smoke_keychain_line" =~ $smoke_keychain_pattern ]] || { echo 'Cannot safely preserve the existing keychain search list.' >&2; exit 1; }
  smoke_existing_keychain="${BASH_REMATCH[1]}"
  [[ "$smoke_existing_keychain" != *\\* ]] || { echo 'Cannot safely preserve an escaped keychain path.' >&2; exit 1; }
  smoke_original_keychains+=("$smoke_existing_keychain")
  smoke_original_keychain_count=$((smoke_original_keychain_count + 1))
done < "$smoke_tmp/original-keychains.txt"
smoke_searchlist_changed=1
if [[ "$smoke_original_keychain_count" -gt 0 ]]; then
  bounded /usr/bin/security list-keychains -d user -s "$smoke_keychain" "${smoke_original_keychains[@]}" >"$smoke_diagnostics" 2>&1
else
  bounded /usr/bin/security list-keychains -d user -s "$smoke_keychain" >"$smoke_diagnostics" 2>&1
fi
mark 'importing the pinned signing identity'
bounded /usr/bin/security import "$smoke_tmp/signing.p12" -k "$smoke_keychain" -P "$WLSAPLUS_CODESIGN_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >"$smoke_diagnostics" 2>&1 || {
  echo 'Could not import the pinned signing identity into the temporary keychain.' >&2; failed; exit 1;
}
mark 'authorizing the temporary signing key'
bounded /usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$smoke_password" "$smoke_keychain" >"$smoke_diagnostics" 2>&1
rm -f "$smoke_tmp/signing.p12"
mark 'validating the pinned self-signed identity'
bounded /usr/bin/security find-certificate -c 'WLSAPlus Self-Signed Code Signing' -p "$smoke_keychain" > "$smoke_tmp/pinned-certificate.pem" 2>"$smoke_diagnostics"
smoke_fingerprint="$(/usr/bin/openssl x509 -in "$smoke_tmp/pinned-certificate.pem" -noout -fingerprint -sha1 | /usr/bin/cut -d= -f2 | /usr/bin/tr -d ':[:space:]' | /usr/bin/tr '[:lower:]' '[:upper:]')"
[[ "$smoke_fingerprint" == "$identity" ]] || { echo 'The imported certificate does not match the installed-app trust pin.' >&2; exit 1; }
if ! bounded /usr/bin/security find-identity -v -p codesigning "$smoke_keychain" | /usr/bin/grep -qi "$identity"; then
  # A fresh self-signed identity needs OS code-signing trust. Never alter a local
  # developer's trust settings. Hosted CI is ephemeral and supports sudo -n.
  [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
    echo 'The pinned self-signed certificate is not trusted locally; this test changes OS trust only on an ephemeral hosted CI runner.' >&2; exit 1;
  }
  bounded /usr/bin/security trust-settings-export "$smoke_tmp/user-trust.plist" >"$smoke_diagnostics" 2>&1 || true
  bounded sudo -n /usr/bin/security trust-settings-export -d "$smoke_tmp/admin-trust.plist" >"$smoke_diagnostics" 2>&1 || true
  if /usr/bin/grep -qi "$identity" "$smoke_tmp/user-trust.plist" "$smoke_tmp/admin-trust.plist" 2>/dev/null; then
    echo 'Preexisting trust settings for the pinned certificate are not usable; refusing to change them.' >&2; exit 1;
  fi
  if bounded /usr/bin/security find-certificate -a -c 'WLSAPlus Self-Signed Code Signing' -Z /Library/Keychains/System.keychain 2>/dev/null | /usr/bin/grep -qi "$identity"; then
    smoke_system_certificate_added=0
  else
    smoke_system_certificate_added=1
  fi
  # Arm cleanup before the command: interruption after the trust write must not
  # leave test-added trust behind. No matching preexisting trust was found above.
  smoke_trust_added=1
  bounded sudo -n /usr/bin/security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$smoke_tmp/pinned-certificate.pem" >"$smoke_diagnostics" 2>&1
fi
bounded /usr/bin/security find-identity -v -p codesigning "$smoke_keychain" | /usr/bin/grep -qi "$identity"
requirement='identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"764D4389AAFA0C50311E39C17DDFA1981ABEF86C"'
version=2.0.0
mark 'signing throwaway application copies'
mkdir -p "$smoke_tmp/package" "$smoke_tmp/installed"
new_app="$smoke_tmp/package/WLSAPlus.app"
old_app="$smoke_tmp/installed/WLSAPlus.app"
/usr/bin/ditto "$app" "$new_app"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$new_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$new_app/Contents/Info.plist"
bounded /usr/bin/codesign --force --sign "$identity" --keychain "$smoke_keychain" --timestamp=none "$new_app" >"$smoke_diagnostics" 2>&1
bounded /usr/bin/codesign --verify --deep --strict "$new_app"
bounded /usr/bin/codesign --verify "-R=$requirement" "$new_app"
/usr/bin/lipo "$new_app/Contents/MacOS/WLSAPlus" -verify_arch arm64 x86_64
# A throwaway trusted target represents the old installed bundle. This is a
# native binary stamped 1.1.2, not an original Electron binary.
/usr/bin/ditto "$new_app" "$old_app"
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 1.1.2' "$old_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 1.1.2' "$old_app/Contents/Info.plist"
bounded /usr/bin/codesign --force --sign "$identity" --keychain "$smoke_keychain" --timestamp=none "$old_app" >"$smoke_diagnostics" 2>&1
mark 'creating the signed native update fixture'
archive="$smoke_tmp/WLSAPlus-$version-macOS-universal.zip"
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$new_app" "$archive"
"$new_app/Contents/MacOS/WLSAPlus" --validate-archive "$archive"
"$new_app/Contents/MacOS/WLSAPlus" --make-manifest --version "$version" --tag "v$version" --out "$smoke_tmp/update-manifest.json" --file "universal=$archive"
# The child test only consumes the public signature; don't propagate secrets.
unset WLSAPLUS_CODESIGN_P12_BASE64 WLSAPLUS_CODESIGN_P12_PASSWORD WLSAPLUS_UPDATE_ED25519_KEY
mark 'running the unchanged legacy updater oracle'
node Tests/signed-update-compat.mjs "$smoke_tmp" "$legacy" "$old_app" "$smoke_tmp/update-manifest.json" "$archive" "$version"
echo 'PASS signed compatibility smoke: unchanged 1.1.2 updater accepted the native package using the pinned release trust.'
echo 'Scope: real updater staging/tools and optional helper startup; no original Electron runtime or public release was executed.'
