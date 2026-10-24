# WLSAPlus Native Rewrite

This is the **currently supported macOS product path**: an independently written native project that uses macOS 13+ system frameworks and Apple's build tools. It shares no code or runtime with the Windows / Android editions; the VPN / network stack is also a brand-new native implementation and does not link or distribute mihomo, gVisor, sing-box, WireGuard or any other third-party core. Official installers and in-app updates are built and released from this directory (see the release workflow at the repository root). Some listed scenarios still have validation limits — passing offline or CI spot checks is not the same as full acceptance across every real Mac scenario.

The UI keeps the Home, Schedule, Progress, Forum, Tools and Settings entry points. WebKit only renders local HTML/CSS/JavaScript; accounts, files, networking, notifications, VPN and updates are implemented in Swift/C. There are no npm, Swift Package, third-party VPN core or third-party runtime dependencies.

## Build and check

**End users should install by building from source** (see the root README and `release-kit/wlsaplusmac版本说明书.md`). On a Mac with the Xcode Command Line Tools installed:

```sh
# Recommended: build 2.0.0 directly (no need to run test.sh just to install the app)
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

Full developer check:

```sh
bash scripts/test.sh
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

You can also double-click `release-kit/编译wlsaplus.command` in the repository. The resulting app contains both arm64 and x86_64. It is ad-hoc signed by default (others will usually see "developer cannot be verified"; right-click → Open works); official builds for the update channel must use the existing fixed certificate and update key.

Public VPN description: the core is **MockMini, our own open-source engine** (Apache-2.0). See the "VPN" section below and the root README for implementation details.

Linux can run the C packet engine, JavaScript and Swift Core tests. Swift syntax checks on Linux do not verify Apple SDK types or system behaviour and cannot replace a macOS build.

Mac CI has passed the dual-architecture build, real WebKit UI / native bridge / schedule parser startup, real tunnel traffic and network recovery through existing VMess nodes, and update-compatibility checks with the original key and fixed certificate. The first fully passing run is [Mac CI15](https://github.com/yezicheng2011/wlsaplus-enablemacos/actions/runs/39216072417). These validate the listed scenarios only and are not equivalent to acceptance of every feature and network environment.

## VPN

Nodes are still read from the existing subscription URL. Supported: Shadowsocks AES-256-GCM as declared by that subscription, VMess legacy and AEAD authentication, plus TCP, TLS, WebSocket and UDP. Cryptography uses CryptoKit/CommonCrypto, networking uses Network.framework, and the tunnel uses the system utun. The protocol and packet-handling code is newly written for this project and does not link or distribute mihomo, gVisor, sing-box, WireGuard or similar implementations.

The local TCP endpoint implements checksums, sequence and acknowledgement numbers, out-of-order buffering, windowing, retransmission, FIN/RST, and bounded IPv4/IPv6 fragment reassembly. It is still a new implementation that needs real-world stress and interoperability testing: at most 128 flows per instance, no window-scaling/SACK/timestamp negotiation, and no forwarding of ICMP or IPsec. See `Sources/Packet/README.md` for details.

The privileged helper only reports "connected" after protocol egress verification, utun configuration, the route/DNS transaction and an HTTPS check through the tunnel have all completed. It watches the parent process and physical network changes and restores routes and DNS on disconnect; if restoration fails, it keeps a recovery log and blocks update installation. The first launch and first connection require macOS administrator authorization.

Real-node spot checks used a standalone test implementation to verify that 4 existing VMess TCP/TLS nodes accept legacy authentication with the primary UUID. Mac CI has used the native client and existing VMess nodes to pass utun, HTTPS 204, UDP DNS, C-engine TCP/UDP traffic and bidirectional proxy byte checks; random DNS queries also verified the send, authenticated response and successful write-back to utun stages. After disconnecting, the original route/DNS and helper-exit checks all passed. In earlier spot checks, SS and some WS nodes exhausted the per-connection budget during TCP connect (AAAA-first or unreachable addresses consumed the probe time before protocol negotiation began). This now dials each resolved address IPv4 → IPv6 with short timeouts, and the smoke test soft-probes SS/WS and logs the result after VMess passes. Protocol interoperability and real user networks still need acceptance testing on real Macs.

## In-app update compatibility

The original bundle ID `cn.org.wlsash.wlsaplus`, product identifier `wlsaplus-macos`, original Ed25519 public key, code-signing certificate fingerprint, update site, mirror candidates, manifest format=1 and launch-confirmation parameters are all preserved. The original updater checks the app identifier, version, processor and signature and does not require Electron resources, so it accepts a new native package that is correctly signed under those conditions.

The new implementation includes stable/test channels, version and rollback blocklist checks, resumable system downloads, size/SHA-256 verification, ZIP safety checks, code-signature verification, disconnecting the VPN before quitting, replacement/backup, and a 90-second launch-confirmation rollback. New versions are still downloaded and installed with a restart via the update button in Settings.

Release preparation uses the existing CI secrets (no replacement keys are generated):

```sh
WLSAPLUS_VERSION=2.0.0-beta.1 bash scripts/release.sh
```

You must first import the original fixed code-signing certificate and set `WLSAPLUS_UPDATE_ED25519_KEY`. Output file names and the manifest format remain compatible with older versions. `release.sh` only prepares artifacts locally; the release workflow at the repository root replaces the old Electron artifact pipeline — stable releases are created as drafts, and test builds update the existing beta channel. When publishing an accepted stable draft you must tick "Set as the latest release" (CLI: `gh release edit v<version> --draft=false --latest`) so that the stable update button in both old and new versions can find it. The following must be verified on a real Mac: upgrading from 1.1.2 → the new version, the next native-to-native upgrade, cancelling authorization, a non-writable Applications folder, resumed downloads and forced rollback.

`scripts/signed-update-compat.sh` is an optional signing-compatibility test. Mac CI has used the original secrets to sign a test copy, generated a manifest verifiable with the original public key, and completed arm64/x64 download, unpacking, signature, architecture and readiness checks through the unmodified 1.1.2 updater from the original repository; the original install helper script has also passed replacement into a temporary target and launch confirmation of the new native app. The native install helper itself has passed replacement, launch confirmation and backup cleanup from a renamed temporary `.app` 1.1.2 test copy to a 2.0.0 test copy. The test publishes no artifacts and uses the updater module and temporary targets, so it cannot replace an upgrade acceptance test of the full old Electron app. To run it from this directory alone, point `WLSAPLUS_LEGACY_ELECTRON_DIR` at the original repository's `electron` directory and explicitly set `WLSAPLUS_RUN_SIGNED_COMPAT_SMOKE=1`.

## Features and data

PowerSchool sign-in uses the original server's public HTML/JSON endpoints; the password is stored only in the system Keychain, and pages are parsed in an inert DOM without running server scripts. Once an account is saved, the app syncs at launch and every 15 minutes; background failures keep the cache, and manual actions take priority. A recognizably empty holiday schedule does not block grade refreshes. Schedules, grades, assignments, attendance, tasks and settings are stored locally. Notifications fire five minutes before class based on real time and are unaffected by simulated display time.

The grades table identifies columns by grouped headers and course information, supports multiple terms and extra columns, and keeps grades, terms and detail links aligned. An explicitly selected term is never replaced by another term even if its grades haven't been published. Text extraction excludes hidden hints and keeps visible grade symbols and HTML paragraph breaks; previously cached incorrect data is refreshed after a re-sync.

The forum uses an isolated WebKit data store and a host allow-list, supports the theme/embed protocol, and a one-time SSO that hands over only the allowed PowerSchool session cookies. Passwords are never passed to the forum. Translation still uses the existing online service API. The campus map has been redrawn as a building diagram with building details and classroom-to-building lookup; it does not claim to be an accurately surveyed floor plan.

On first launch, the app performs a read-only parse of the valid LevelDB manifest, tables and logs of the original Chromium local storage, and migrates schedules, grades, tasks, appearance and node selection. Migration verifies checksums, deletion records, compression formats and file stability; when data cannot be safely identified, it shows a notice and leaves the original directory untouched, without guessing or overwriting. Synthetic samples cover the migration logic; real user databases still need verification. The old version's Electron-encrypted account password is not decrypted or migrated, so you need to sign in again the first time you use the native version.

## Code origin and rights boundaries

See `PROVENANCE.md` for the provenance of new code and assets. An independent rewrite is a different question from the absence of any third-party intellectual property; rights in the operating system, compilers, public protocols, service names and the servers themselves do not belong to this project. No claim is made here of a completed legal review, patent search or certifiable clean-room development, and the copyright and licensing of the original repository's historical code are not changed.

## License

This native stack (including the Packet / VPN protocol implementation) is licensed under the **Apache License 2.0**; see `LICENSE` at the repository root. The implementation is original Swift/C and contains no source code or binaries from mihomo / clash / sing-box / gVisor or other third-party cores.
