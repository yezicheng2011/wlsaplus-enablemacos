# Third-party notices

WLSAPlus (this repository) is licensed under the **Apache License 2.0**. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

The native macOS client (`native/`), including the MockMini Swift/C VPN and packet engine, local WebKit workspace assets, update wire-contract verifier, and build/release scripts, is original software licensed under **Apache-2.0**. It does **not** vendor, link, or distribute `mihomo`, `clash`, `sing-box`, `gVisor`, Electron, Angular, or third-party npm runtime packages. The historical 1.x Electron/Angular tree and bundled `mihomo` binary have been retired and removed from this repository.

## Runtime platform dependencies

All runtime frameworks and system utilities used by the shipped macOS app are provided by macOS 13 or later under Apple's system software terms:

| Component | Role |
| --- | --- |
| AppKit / Foundation / WebKit | Native windowing, local interface rendering, and isolated forum web container |
| Network.framework / Darwin `utun` | Outbound TLS/TCP/UDP transport and full-device packet tunnel interface |
| CryptoKit / CommonCrypto / Security | AEAD/stream cryptography, Ed25519 manifest verification, and Keychain credential storage |
| UserNotifications / ServiceManagement | Class reminders and system integration |

## Development and verification tools (not distributed)

Build and test scripts invoke standard host toolchains during development and CI only; none of these tools are bundled into `WLSAPlus.app`:

- Apple Xcode Command Line Tools (`clang`, `swiftc`, `lipo`, `codesign`, `ditto`, `hdiutil`), plus Xcode's `actool` when compiling the layered app icon
- Node.js 22+ built-in standard library (`node:test`, `node:crypto`, `node:http`, `node:fs`)
- Python 3 standard library (test archive and migration fixture generation)
- Chromium / Google Chrome (optional local/CI headless DOM verification)

## Attribution note

Product names (PowerSchool, WeChat, macOS, etc.) belong to their respective owners. Network reachability probes (for example `https://weixin.qq.com/`) are connectivity checks only and are not affiliated with or endorsed by those services.
