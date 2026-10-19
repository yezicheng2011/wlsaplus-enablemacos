#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Native VPN smoke testing requires macOS.' >&2; exit 1; }
mkdir -p .build
sdk="$(xcrun --sdk macosx --show-sdk-path)"
arch="$(uname -m)"
xcrun clang -std=c11 -g -Wall -Wextra -Werror -target "$arch-apple-macos13.0" -isysroot "$sdk" -c Sources/Packet/wlp.c -o .build/smoke-wlp.o
xcrun clang -std=c11 -g -Wall -Wextra -Werror -target "$arch-apple-macos13.0" -isysroot "$sdk" -c Sources/Packet/utun.c -o .build/smoke-utun.o
xcrun swiftc -swift-version 5 -Onone -D NATIVE_INTEGRATION_TESTS -target "$arch-apple-macos13.0" -sdk "$sdk" -import-objc-header Sources/Bridge.h \
  Sources/Core/*.swift Sources/VPN/*.swift Sources/Platform/*.swift Sources/App/*.swift .build/smoke-wlp.o .build/smoke-utun.o \
  -framework AppKit -framework WebKit -framework Network -framework Security -framework CryptoKit \
  -framework SystemConfiguration -framework UserNotifications -framework ServiceManagement -o .build/native-vpn-smoke
python3 - <<'PY'
import subprocess,time
try:
    subprocess.run(['.build/native-vpn-smoke','--native-vpn-smoke'],check=True,timeout=210)
finally:
    # The root helper watches parent exit and performs recovery after timeout.
    time.sleep(3)
PY
