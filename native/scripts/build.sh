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
  xcrun swiftc -swift-version 5 -O -whole-module-optimization -target "$arch-apple-macos13.0" -sdk "$sdk" -import-objc-header Sources/Bridge.h \
    "${sources[@]}" ".build/wlp-$arch.o" ".build/utun-$arch.o" \
    -framework AppKit -framework WebKit -framework Network -framework Security -framework CryptoKit \
    -framework SystemConfiguration -framework UserNotifications -framework ServiceManagement -o ".build/WLSAPlus-$arch"
done
app='out/WLSAPlus.app'
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
xcrun lipo -create .build/WLSAPlus-arm64 .build/WLSAPlus-x86_64 -output "$app/Contents/MacOS/WLSAPlus"
cp Resources/* "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>cn.org.wlsash.wlsaplus</string>
<key>CFBundleName</key><string>WLSAPlus</string>
<key>CFBundleDisplayName</key><string>WLSAPlus</string>
<key>CFBundleExecutable</key><string>WLSAPlus</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>${version%%-*}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.education</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
EOF
identity="${WLSAPLUS_SIGN_IDENTITY:--}"
/usr/bin/codesign --force --sign "$identity" --timestamp=none "$app"
/usr/bin/codesign --verify --deep --strict "$app"
xcrun lipo "$app/Contents/MacOS/WLSAPlus" -verify_arch arm64 x86_64
COPYFILE_DISABLE=1 /usr/bin/ditto --norsrc --noextattr --noqtn -c -k --keepParent "$app" out/WLSAPlus-native-review.zip
"$app/Contents/MacOS/WLSAPlus" --validate-archive out/WLSAPlus-native-review.zip
echo "Built $app ($version). Release updates additionally require the pinned certificate and signing key."
