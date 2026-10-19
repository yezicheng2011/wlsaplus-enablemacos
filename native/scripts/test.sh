#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
${CC:-cc} -std=c11 -g -Wall -Wextra -Werror -fsanitize=address,undefined Sources/Packet/wlp.c Sources/Packet/utun.c Tests/packet_test.c -o .build/packet-tests
ASAN_OPTIONS=detect_leaks=1 .build/packet-tests
node --test Tests/*.test.mjs
python3 Tests/archive-fixtures.py .build/archive-fixtures
python3 Tests/generate_legacy_fixtures.py Tests/Fixtures/Legacy
if [[ "$(uname -s)" == Darwin ]]; then
  xcrun swiftc -swift-version 5 Sources/Core/*.swift Sources/VPN/*.swift Tests/LegacyTests.swift Tests/ProtocolTests.swift Tests/NativeTests.swift -o .build/native-tests
else
  "${SWIFTC:-swiftc}" -swift-version 5 Sources/Core/*.swift Tests/LegacyTests.swift Tests/NativeTests.swift -o .build/native-tests
fi
.build/native-tests
