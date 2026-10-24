# Provenance

The Swift, C, HTML, CSS, JavaScript, tests and build scripts in this directory were newly written for this project. No third-party VPN core, TCP/IP stack, proxy protocol library, web framework, font, icon library or implementation file from the original repository was copied, and the original core binary is not distributed. Icon paths, UI styles and the campus building diagram were drawn within this project.

The main implementer read the original repository's interfaces, data formats and update constraints to stay compatible; some subtasks were written solely from functional descriptions and public protocols. This is not a legally audited clean-room process and cannot be taken as a guarantee that no third-party rights exist.

All permitted runtime dependencies are provided by macOS: AppKit, WebKit, Foundation, Network.framework, Security/Keychain, CryptoKit, CommonCrypto, UserNotifications, ServiceManagement, Darwin/utun, and the system routing and DNS tools. Apple's compilers and system SDK headers are used for building. System components and public protocols are not claimed as original technology.

Interoperability identifiers (bundle ID, update product name, public key, certificate fingerprint, subscription/update/forum/translation URLs, server fields) are retained from the existing deployment contract. They contain no private keys or node credentials. `Tests/Fixtures/legacy-update-manifest.json` is the publicly released 1.1.2 signed manifest data and is used only to verify update-format compatibility.

Protocol and platform references:

- [Shadowsocks AEAD wire specification](https://shadowsocks.org/doc/aead.html)
- [VMess protocol documentation](https://www.v2fly.org/developer/protocols/vmess.html)
- [VMess AEAD documentation](https://www.v2fly.org/developer/protocols/vmess.html#vmess-aead)
- [RFC 6455 WebSocket](https://www.rfc-editor.org/rfc/rfc6455)
- [RFC 9293 TCP](https://www.rfc-editor.org/rfc/rfc9293)
- [PKWARE ZIP format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)
- [Apple Network framework](https://developer.apple.com/documentation/network)
- [Apple CryptoKit](https://developer.apple.com/documentation/cryptokit)
- [LevelDB file-format descriptions](https://github.com/google/leveldb/blob/main/doc/table_format.md)
- [Chromium local-storage format description](https://www.cclsolutionsgroup.com/post/chromium-session-storage-and-local-storage)

Test tools are used only during development and are not distributed with the app: C/Swift compilers, Node's built-in test/crypto modules, the Python standard library, Chromium, and the system cryptography APIs used by the standalone protocol tests. Real subscription and node test inputs are kept in private temporary files in the workspace and are not included in this directory or in release artifacts.

The optional signing-compatibility test uses the original repository's `electron/mac-updater.cjs`, its dependencies and install scripts as a read-only reference, and verifies that those files are unchanged; they are not copied into the new app or this directory. The test only proves the listed interoperability steps and does not mean the original Electron app has been fully accepted.

The original repository's license history, upstream contributors' code and third-party component rights still apply. This record does not replace an assignment of rights, a license opinion or a patent search. Publishers should determine the applicable notices based on the code/assets actually retained and the deployment requirements; removing old notices does not acquire upstream rights.
