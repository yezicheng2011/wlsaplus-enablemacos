# WLSAPlus · macOS

<p align="center">
  <img src="public/icons/app-icon.svg" width="96" alt="WLSAPlus">
</p>

<p align="center">
  A local-first schedule &amp; study app for WLSA students<br>
  <b>macOS 13+ · Universal (Intel x86_64 + Apple silicon arm64)</b> · Native Swift / C
</p>

<p align="center">
  <a href="#build-from-source">Build from source</a> ·
  <a href="release-kit/wlsaplusmac版本说明书.md">Manual</a> ·
  <a href="https://wlsaplus.spacehubxyz.hk/#download">Official site</a> ·
  <a href="native/README.md">Native docs</a>
</p>

> **Current product**  
> The macOS client has been fully rewritten as an **independent native** app (Swift / C; system AppKit, WebKit, Network, CryptoKit, and related frameworks).  
>  
> **Other platforms**  
> This macOS edition is an independent product line and does **not** share code or runtime with the Windows / Android editions.  
>  
> **Network & VPN core**  
> The VPN core is **MockMini, our own open-source engine** ([Apache-2.0](LICENSE); site [mockmini.danielye2011.uk](https://mockmini.danielye2011.uk/)), built on system utun + Network.framework + CryptoKit/CommonCrypto. It **no longer uses** the former shared core (mihomo / Clash Meta) or any third-party VPN runtime.  
>  
> **How to install (important)**  
> **End users should build from source** using the steps below and the [manual](release-kit/wlsaplusmac版本说明书.md). GitHub Releases are mainly for developer self-testing and the in-app update channel — they are **not** the primary install path for classmates.

---

## About

WLSAPlus brings your PowerSchool schedule, grades, attendance, class reminders, campus tools and the WLSAPlus forum into one native Mac app. Data stays on your Mac, and the last sync is available offline.

> This repository ships the **macOS** client only; it is independent of the Windows and Android editions.

## Features

| Feature | Description |
|---|---|
| 💬 **WLSAPlus Forum** | Embedded forum; **auto sign-in** with the current PowerSchool session (your password never leaves the Mac; posts stay anonymous); **light/dark follows the app theme**; embed mode uses the forum's **bottom navigation** |
| 📅 **Schedule** | Synced from PowerSchool, cached locally, works offline |
| 📈 **Progress** | Course grades, assignment scores, attendance |
| 🔔 **Reminders** | macOS notification about 5 minutes before class (optional) |
| 🛡️ **VPN** | Subscription nodes, latency test, full-device tunnel; the core is **MockMini, our own open-source engine** (Apache-2.0) |
| 🧰 **Tools** | Campus map, translator, to-dos |
| 🎨 **Appearance** | System / light / dark, multiple accent colours |

## Build from source

**This is the recommended install path for classmates.** No Apple Developer account is needed, and no Node / npm / Homebrew for a normal build.

### Requirements

- macOS **13** or later (Intel or Apple silicon)
- **Xcode Command Line Tools** installed (if not, run `xcode-select --install` in Terminal and follow the prompts)

### Commands (copy the whole block)

On networks in mainland China, clone through the **gh-proxy.com** mirror first (don't confuse it with `ghproxy.com`, which is often blocked). As fallbacks, swap the host for `ghproxy.net` or `ghfast.top` (same path).

```bash
# 1) Clone the repository (mirror recommended in mainland China)
git clone https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos.git
cd wlsaplus-enablemacos

# 2) Enter the native project and build (universal: arm64 + x86_64)
cd native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh

# 3) Open the freshly built app
open out/WLSAPlus.app
```

The four core lines classmates can copy (mirror clone + build + open):

```bash
git clone https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos.git
cd wlsaplus-enablemacos/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

If `git clone` still fails, download the zip through the same mirror:

```bash
curl -L -o wlsaplus-enablemacos.zip 'https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos/archive/refs/heads/main.zip'
unzip wlsaplus-enablemacos.zip
cd wlsaplus-enablemacos-main/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

If you can reach GitHub directly, use `https://github.com/yezicheng2011/wlsaplus-enablemacos.git` instead.

Optional: install into Applications and clear the quarantine flag (reduces false "damaged" warnings):

```bash
ditto out/WLSAPlus.app /Applications/WLSAPlus.app
xattr -cr /Applications/WLSAPlus.app
open /Applications/WLSAPlus.app
```

Even easier: after cloning, double-click [`release-kit/编译wlsaplus.command`](release-kit/编译wlsaplus.command) in the repository (it checks the command line tools → builds → opens the app). See the [manual](release-kit/wlsaplusmac版本说明书.md) for full step-by-step instructions.

### "Developer cannot be verified / not safe" on first launch (Gatekeeper)

Builds use **ad-hoc / project self-signing** by default; an Apple Developer ID or notarization is **neither needed nor required**. Other people opening the app will usually see "developer cannot be verified" or "not safe". **Just do the following** (this is expected and does not mean the build failed):

- In Finder, **right-click `WLSAPlus.app` → Open → Open**, or go to **System Settings → Privacy & Security → Open Anyway**
- If it still says the app is "damaged", run in Terminal:

```bash
xattr -cr /Applications/WLSAPlus.app
# If the app is still in the out/ directory:
# xattr -cr "$(pwd)/out/WLSAPlus.app"
```

### Optional tests

The full test suite also needs `node` and `python3` on your Mac (you do **not** need to run it just to install the app):

```bash
cd native
bash scripts/test.sh
```

### Legacy Electron tree (migration / compatibility / rights record only)

The repository root still contains the old Electron + Angular Material app and its `npm` scripts, kept for data migration, update compatibility and the historical rights record. **The new app does not bundle the old Electron runtime or the old VPN core.** For everyday installs and releases, use the `native/` commands above — **do not** install it for classmates with the old `npm install` / `npm run electron:make`.

Legacy Electron commands (not the supported product path):

```bash
# Node.js 22 (see .nvmrc) — legacy tree only
npm install
npm run electron:make
```

## Development

| Path | Description |
|---|---|
| [`native/`](native/) | **The currently supported native app** (Swift / C, local WebKit UI) |
| Repository root (`src/`, `electron/`, …) | Legacy Electron implementation only |

CI:

- **Native check** (`native-check.yml`)
- **Build and release native macOS app** (`release.yml`): builds from `native/`; stable releases can be created as drafts and then marked Latest (for in-app updates)

Optional signing / notarization secrets (for maintainer releases only; classmates building the app don't need them):

| Purpose | Secrets |
|---|---|
| Code signing | `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_IDENTITY` |
| Notarization | `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` |
| In-app update signing | `WLSAPLUS_UPDATE_ED25519_KEY` |

See [native/README.md](native/README.md) and [native/PROVENANCE.md](native/PROVENANCE.md) for details.

## Privacy

- Schedules, grades and to-dos are stored on your Mac; your PowerSchool password is kept in the system Keychain / system encrypted storage.
- Forum auto sign-in only hands the current PowerSchool session cookies (allow-listed) to the forum server for one-time verification and never sends your password; the forum runs in an isolated WebKit data store.

## License

The source code is released under the **Apache License 2.0**; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Third-party licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

For the origin and rights boundaries of the native project, see [`native/PROVENANCE.md`](native/PROVENANCE.md). The legacy Electron tree may still reference licenses of components shipped with older versions (e.g. [`electron/bin/LICENSE-mihomo.txt`](electron/bin/LICENSE-mihomo.txt)); **the native app no longer distributes that core**.

© daniel.ye
