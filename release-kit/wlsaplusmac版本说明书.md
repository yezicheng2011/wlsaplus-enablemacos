# WLSAPlus for macOS — User Manual (2.0.0)

How classmates should install it: **build from source by following this guide**. You don't need an Apple Developer account, and you shouldn't treat the one-click DMG on the website / GitHub as the main install path (that is for developer self-testing and in-app updates).

© daniel.ye

---

## What this is

- **Product**: the WLSAPlus macOS client (schedule, grades, attendance, class reminders, campus tools, forum, VPN)
- **Form**: a **native** macOS app (Swift / C), **fully independent** of the Windows / Android editions
- **VPN core**: **MockMini, our own open-source engine** (Apache-2.0; see [mockmini.danielye2011.uk](https://mockmini.danielye2011.uk/)); the old mihomo / Clash Meta core is no longer used
- **Current version**: 2.0.0

## System requirements

- macOS **13** or later
- Both **Intel (x86_64) and Apple silicon (arm64)** are supported (the build output is universal)
- The **Xcode Command Line Tools** must be installed (not the full Xcode app — much smaller)
- **Not needed**: Homebrew, Node.js, npm, a paid Apple Developer account

## Install: build from source (recommended)

### Option A: copy commands into Terminal (clearest)

1. Open **Terminal** (Launchpad → Other → Terminal).
2. If you've never installed the command line tools, run this first (follow the prompts in the pop-up window, then continue once it finishes):

```bash
xcode-select --install
```

3. Copy and run the whole block below (**the gh-proxy.com mirror is recommended in mainland China**; don't confuse it with `ghproxy.com`, which is often blocked. As fallbacks, swap the host for `ghproxy.net` or `ghfast.top`):

```bash
git clone https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos.git
cd wlsaplus-enablemacos/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

If `git clone` fails, download the zip through the same mirror and build:

```bash
curl -L -o wlsaplus-enablemacos.zip 'https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos/archive/refs/heads/main.zip'
unzip wlsaplus-enablemacos.zip
cd wlsaplus-enablemacos-main/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

If you can reach GitHub directly, use `https://github.com/yezicheng2011/wlsaplus-enablemacos.git` instead.

4. (Optional) Install into Applications:

```bash
ditto out/WLSAPlus.app /Applications/WLSAPlus.app
xattr -cr /Applications/WLSAPlus.app
open /Applications/WLSAPlus.app
```

After a successful build, the app is at `wlsaplus-enablemacos/native/out/WLSAPlus.app`.

### Option B: double-click the one-click build script

If you have already cloned this repository to your Mac:

1. In Finder, open the `release-kit` folder in the repository
2. Double-click **`编译wlsaplus.command`**
3. If it says it can't be opened: right-click → Open → Open, or run `chmod +x` on it in Terminal first and then double-click
4. The script checks the command line tools → builds 2.0.0 → opens the app

> **Mirrors for mainland China (in order of preference)**: `gh-proxy.com` → `ghproxy.net` → `ghfast.top` (just replace the host name in the clone / zip URL). Don't use `ghproxy.com` (no hyphen), which is often blocked. The build itself does **not** depend on npm and does not download Electron or a VPN core from overseas.

## First launch: why it says "not safe" rather than "damaged"

The build output is **self-signed** (ad-hoc) by default; it is **not** notarized by Apple, and doesn't need to be.

- **Normal case**: you see "developer cannot be verified" or "not safe" → **right-click the app → Open → Open**, or go to **System Settings → Privacy & Security → Open Anyway**.
- **If it still says "damaged"**: this is usually the quarantine attribute (common when copied from cloud storage or a browser). Run in Terminal:

```bash
xattr -cr /Applications/WLSAPlus.app
# Or for the bundle in the out directory:
# xattr -cr /path/to/wlsaplus-enablemacos/native/out/WLSAPlus.app
```

Then right-click → Open again. When sharing with classmates, prefer sending **a `.app` you built yourself** and remind them to open it with right-click; don't expect an un-notarized app to pass silently like an App Store app.

## Using the app (features)

### Schedule and grades

After you Connect / sync PowerSchool in the app, you can view them in Schedule and Progress (grades, assignments, attendance). Data is stored locally; the last sync is viewable offline. When moving from the old Electron version to 2.0.0 for the first time, **you need to sign in again** (the old encrypted format is not automatically decrypted and migrated).

### WLSAPlus Forum

The **Forum** tab in the sidebar (bottom bar when the window is narrow):

- **Auto sign-in** when PowerSchool is synced (only the session is passed on; your password is never sent to the forum; posts stay anonymous)
- Light / dark follows the app theme
- Embed mode uses the forum's bottom navigation

### VPN (MockMini)

1. Open Tools → VPN
2. Optionally refresh nodes and test latency, then select a node
3. Click Connect; if an administrator authorization prompt appears, enter your Mac password and allow it
4. To disconnect, click Disconnect on the VPN page (2.0.0 has **no** old `clash` / mihomo process, so there's no need to kill clash in Activity Monitor)

### Class reminders

Turn Class reminders on or off in Settings. When on, a macOS notification is sent about 5 minutes before class (requires a synced schedule).

## Differences from 1.1.2 / the old manual (at a glance)

| | 1.1.2 and earlier | Now (2.0.0) |
| --- | --- | --- |
| Technology | Electron + Node + `npm run electron:make` | Native Swift/C: `native/scripts/build.sh` |
| How classmates install | Prebuilt package / `working.command` / or build with your own Node | **git clone + build.sh** (or `编译wlsaplus.command`) |
| VPN | mihomo (Clash Meta) | **MockMini, our own open-source engine** (Apache-2.0) |
| Turning off the VPN | Might also need to quit `clash` in Activity Monitor | Just click Disconnect in the app |

## FAQ

**Q: Can I just download the DMG without building?**  
A: The official path for classmates is **building from source** (this guide). Packages on GitHub Releases / the in-app update channel are for maintenance and self-testing; follow this manual.

**Q: The build fails because it can't find `xcrun` / `swiftc`?**  
A: Run `xcode-select --install` first, then reopen Terminal and build again.

**Q: Do I need `npm install`?**  
A: **No**, not for installing 2.0.0. That command is for the old Electron tree.

**Q: Copyright and license?**  
A: The app source code is Apache-2.0; see `LICENSE` / `NOTICE` in the repository. © daniel.ye

## Links

- Source code: <https://github.com/yezicheng2011/wlsaplus-enablemacos>
- MockMini: <https://mockmini.danielye2011.uk/>
- Official site: <https://wlsaplus.spacehubxyz.hk/>
