#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
${CC:-cc} -std=c11 -g -Wall -Wextra -Werror -fsanitize=address,undefined Sources/Packet/wlp.c Sources/Packet/utun.c Tests/packet_test.c -o .build/packet-tests
if [[ "$(uname -s)" == Darwin ]]; then ASAN_OPTIONS=detect_leaks=0 .build/packet-tests; else ASAN_OPTIONS=detect_leaks=1 .build/packet-tests; fi
${CC:-cc} -std=c11 -g -Wall -Wextra -Werror -fsanitize=address,undefined Sources/Packet/wlp.c Tests/packet_fuzz.c -o .build/packet-fuzz
if [[ "$(uname -s)" == Darwin ]]; then ASAN_OPTIONS=detect_leaks=0 MOCKMINI_FUZZ_STEPS="${MOCKMINI_FUZZ_STEPS:-400000}" .build/packet-fuzz; else ASAN_OPTIONS=detect_leaks=1 MOCKMINI_FUZZ_STEPS="${MOCKMINI_FUZZ_STEPS:-400000}" .build/packet-fuzz; fi
node --test Tests/*.test.mjs
python3 Tests/archive-fixtures.py .build/archive-fixtures
python3 Tests/generate_legacy_fixtures.py Tests/Fixtures/Legacy
if [[ "$(uname -s)" == Darwin ]]; then
  xcrun swiftc -swift-version 5 -D NETWORK_PLAN_TESTS Sources/Core/*.swift Sources/VPN/*.swift Sources/Platform/NetworkPlan.swift Tests/LegacyTests.swift Tests/ProtocolTests.swift Tests/NativeTests.swift -o .build/native-tests
else
  "${SWIFTC:-swiftc}" -swift-version 5 -D NETWORK_PLAN_TESTS Sources/Core/*.swift Sources/Platform/NetworkPlan.swift Tests/LegacyTests.swift Tests/NativeTests.swift -o .build/native-tests
fi
.build/native-tests
