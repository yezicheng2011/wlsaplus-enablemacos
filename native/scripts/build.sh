#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'A Mac with Xcode command-line tools is required.' >&2; exit 1; }
version="${WLSAPLUS_VERSION:-2.0.0}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid WLSAPLUS_VERSION' >&2; exit 1; }
sdk="$(xcrun --sdk macosx --show-sdk-path)"
mkdir -p .build out
sources=(Sources/Core/*.swift Sources/VPN/*.swift Sources/Platform/*.swift Sources/App/*.swift)
for arch in arm64 x86_64; do
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -target "$arch-apple-macos13.0" -isysroot "$sdk" -c Sources/Packet/wlp.c -o ".build/wlp-$arch.o"
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -target "$arch-apple-macos13.0" -isysroot "$sdk" -c Sources/Packet/utun.c -o ".build/utun-$arch.o"
  xcrun clang -std=c11 -O3 -Wall -Wextra -Werror -target "$arch-apple-macos13.0" -isysroot "$sdk" -c Sources/LLM/wlm.c -o ".build/wlm-$arch.o"
  xcrun swiftc -swift-version 5 -O -whole-module-optimization -target "$arch-apple-macos13.0" -sdk "$sdk" -import-objc-header Sources/Bridge.h \
    "${sources[@]}" ".build/wlp-$arch.o" ".build/utun-$arch.o" ".build/wlm-$arch.o" \
    -framework Accelerate -framework AppKit -framework WebKit -framework Network -framework Security -framework CryptoKit \
    -framework SystemConfiguration -framework UserNotifications -framework ServiceManagement -o ".build/WLSAPlus-$arch"
done
app='out/WLSAPlus.app'
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
xcrun lipo -create .build/WLSAPlus-arm64 .build/WLSAPlus-x86_64 -output "$app/Contents/MacOS/WLSAPlus"
cp Resources/* "$app/Contents/Resources/"
# AppIcon.icns covers macOS 13-15 and Command Line Tools builds. With Xcode 26+
# the layered AppIcon.icon is compiled too, so macOS 26 renders the Default,
# Dark, Clear and Tinted appearances. Neither file depends on the processor.
cp Icon/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
icon_variants=0
rm -rf .build/icon
mkdir -p .build/icon
if actool="$(xcrun --find actool 2>/dev/null)"; then
  if "$actool" Icon/AppIcon.icon --compile .build/icon --app-icon AppIcon --platform macosx --target-device mac \
       --minimum-deployment-target 13.0 --output-partial-info-plist .build/icon/partial.plist \
       --output-format human-readable-text --errors --warnings >.build/icon/actool.log 2>&1 \
     && [[ -s .build/icon/Assets.car ]]; then
    cp .build/icon/Assets.car "$app/Contents/Resources/Assets.car"
    icon_variants=1
  fi
fi
if [[ "$icon_variants" == 1 ]]; then
  echo 'App icon: layered icon compiled (Default, Dark, Clear and Tinted on macOS 26).'
elif [[ "${WLSAPLUS_REQUIRE_ICON_VARIANTS:-0}" == 1 ]]; then
  echo 'The layered app icon could not be compiled, and WLSAPLUS_REQUIRE_ICON_VARIANTS=1 requires it.' >&2
  [[ -f .build/icon/actool.log ]] && cat .build/icon/actool.log >&2
  exit 1
else
  echo 'App icon: bitmap icon only. Build with Xcode 26 or later to add the Dark, Clear and Tinted appearances.'
fi
# Optional release-only Clash subscription suggestion. Empty for source builds.
# Never commit a real URL; CI injects WLSAPLUS_DEFAULT_SUBSCRIPTION_URL from a secret/variable.
default_subscription="${WLSAPLUS_DEFAULT_SUBSCRIPTION_URL:-}"
default_subscription="$(printf '%s' "$default_subscription" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -n "$default_subscription" ]]; then
  case "$default_subscription" in
    https://*) ;;
    *) echo 'WLSAPLUS_DEFAULT_SUBSCRIPTION_URL must be an https:// URL when set.' >&2; exit 1 ;;
  esac
  if [[ "$default_subscription" == *"@"* ]]; then
    echo 'WLSAPLUS_DEFAULT_SUBSCRIPTION_URL must not embed credentials.' >&2
    exit 1
  fi
fi
plist_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}
escaped_subscription="$(plist_escape "$default_subscription")"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>cn.org.wlsash.wlsaplus</string>
<key>CFBundleName</key><string>WLSAPlus</string>
<key>CFBundleDisplayName</key><string>WLSAPlus</string>
<key>CFBundleExecutable</key><string>WLSAPlus</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIconName</key><string>AppIcon</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>${version%%-*}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.education</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHumanReadableCopyright</key><string>Copyright © 2026 daniel.ye叶子诚</string>
<key>WLSAPlusDefaultSubscriptionURL</key><string>$escaped_subscription</string>
</dict></plist>
EOF
# Sign AFTER every Contents modification (including Info.plist injection).
# Prefer Developer ID / existing self-signed identity from WLSAPLUS_SIGN_IDENTITY.
# Ad-hoc (-) is only for local source builds; quarantined ad-hoc apps show "is damaged".
identity="${WLSAPLUS_SIGN_IDENTITY:--}"
/usr/bin/codesign --force --deep --sign "$identity" --timestamp=none "$app"
/usr/bin/codesign --verify --deep --strict "$app"
echo "codesign verify --deep --strict: OK (identity=${identity})"
if command -v spctl >/dev/null 2>&1; then
  set +e
  spctl_out="$(/usr/sbin/spctl -a -vv --type execute "$app" 2>&1)"
  spctl_status=$?
  set -e
  echo "spctl -a -vv --type execute:"
  printf '%s\n' "$spctl_out"
  echo "spctl exit status: $spctl_status (self-signed may be rejected by assessment while still avoiding the damaged-app quarantine failure)"
fi
xcrun lipo "$app/Contents/MacOS/WLSAPlus" -verify_arch arm64 x86_64
# ditto zip preserves the sealed signature; do not mutate the .app after signing.
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$app" out/WLSAPlus-native-review.zip
"$app/Contents/MacOS/WLSAPlus" --validate-archive out/WLSAPlus-native-review.zip
echo "Built $app ($version). Release updates additionally require the pinned certificate and signing key."
