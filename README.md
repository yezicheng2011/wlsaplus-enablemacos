# WLSAPlus · macOS

<p align="center">
  <img src="public/icons/app-icon.svg" width="96" alt="WLSAPlus">
</p>

<p align="center">
  面向 WLSA 学生的本地优先课表与学业工具 · A local-first schedule &amp; study app for WLSA students<br>
  <b>macOS 13+ · Universal（Intel x86_64 + Apple silicon arm64）</b> · 原生 Swift / C · Native Swift / C
</p>

<p align="center">
  <a href="https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/tag/v2.0.0">下载 2.0.0 DMG / Download</a> ·
  <a href="https://wlsaplus.spacehubxyz.hk/#download">官网下载 / Official site</a> ·
  <a href="#安装--install">安装 / Install</a> ·
  <a href="native/README.md">原生工程说明 / Native docs</a>
</p>

> **当前产品形态 · Current product**  
> macOS 客户端已完成全面重构，主线为独立原生实现（Swift / C，系统 AppKit、WebKit、Network、CryptoKit 等）。  
> The macOS client has been fully re-architected as an **independent native** implementation (Swift / C; system AppKit, WebKit, Network, CryptoKit, and related frameworks).  
>  
> **与其他平台 · Other platforms**  
> macOS 版为独立原生实现，与 Windows / Android 版本不共用代码与运行时。  
> This is an independent native macOS implementation that does not share code or runtime with the Windows or Android editions.  
>  
> **网络与 VPN 核心 · Network & VPN core**  
> VPN / 网络栈亦为全新原生实现（系统 utun + Network.framework + CryptoKit/CommonCrypto），不再使用旧版共用内核（如 mihomo / Clash Meta）或第三方 VPN 运行时。  
> The VPN and network core have also been rewritten natively (system utun + Network.framework + CryptoKit/CommonCrypto). They no longer use the former shared core (e.g. mihomo / Clash Meta) or a third-party VPN runtime.  
>  
> **发布通道 · Releases**  
> 原生重写已合入 [`main`](https://github.com/yezicheng2011/wlsaplus-enablemacos/tree/main)；正式安装包与应用内更新由 `native/` 构建并发布（见根目录 release workflow）。当前稳定版为 **[v2.0.0](https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/tag/v2.0.0)**（原生自签安装包，约 1.7MB）。普通用户请直接下载 DMG，**无需自行编译**。
> > The native rewrite is on `main`; installers and in-app updates ship from `native/` via the root release workflow. Current stable is **v2.0.0** (native self-signed installer, ~1.7MB). End users should download the DMG — **no need to compile from source**.
> >  
> 细节、验收范围与来源记录见 [native/README.md](native/README.md) 与 [native/PROVENANCE.md](native/PROVENANCE.md)。  
> Details, acceptance scope, and provenance: [native/README.md](native/README.md) and [native/PROVENANCE.md](native/PROVENANCE.md).

---

## 简介 · About

WLSAPlus 把 PowerSchool 课表、成绩、考勤、开课提醒、校园工具和 WLSAPlus 论坛放进一个原生 Mac 应用。数据保存在本机，离线也能查看上一次同步的内容。

WLSAPlus brings your PowerSchool schedule, grades, attendance, class reminders, campus tools and the WLSAPlus forum into one native Mac app. Data stays on your Mac, and the last sync is available offline.

> 本仓库仅提供 **macOS** 客户端；macOS 工程与 Windows / Android 版本相互独立。  
> This repository ships the **macOS** client only; the macOS codebase is independent of the Windows and Android editions.

## 功能 · Features

| | 中文 | English |
|---|---|---|
| 💬 **WLSAPlus 论坛** | 论坛内嵌在应用里；已同步 PowerSchool 时**自动登录**（只转交当前会话，密码不出本机，帖子仍匿名）；**浅色/深色跟随应用主题**；嵌入模式使用论坛**底部导航** | Embedded forum; **auto sign-in** with the current PowerSchool session (password never leaves the Mac; posts stay anonymous); **light/dark follows the app theme**; embed mode with the forum **bottom navigation** |
| 📅 **课表 Schedule** | 从 PowerSchool 同步，本地缓存，离线可看 | Synced from PowerSchool, cached locally, works offline |
| 📈 **成绩 Progress** | 课程等级、作业分数、考勤 | Course grades, assignment scores, attendance |
| 🔔 **开课提醒 Reminders** | 开课前约 5 分钟 macOS 通知（可关） | macOS notification ~5 min before class (optional) |
| 🛡️ **VPN** | 订阅节点、延迟测速、全设备隧道；**原生网络栈**（非旧版共用内核） | Subscription nodes, latency test, full-device tunnel; **native network stack** (not the former shared core) |
| 🧰 **工具 Tools** | 校园地图、翻译、待办 | Campus map, translator, to-dos |
| 🎨 **外观 Appearance** | 跟随系统 / 浅色 / 深色，多种主题色 | System / light / dark, multiple accent colours |

## 安装 · Install

**系统要求 / Requirements:** macOS 13 或更新；**universal（通用）构建**，同一个 `WLSAPlus.app` 同时支持 **Intel（x86_64）与 Apple 芯片（arm64）**。  
macOS 13+; a single **universal** `WLSAPlus.app` runs on **both Intel (x86_64) and Apple silicon (arm64)**.

1. 到 [Releases](https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/latest) 下载最新版本。  
   Download the latest build from [Releases](https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/latest).
2. 有 DMG 时：打开 DMG，把 **WLSAPlus** 拖进「应用程序」；若带有安装脚本，可按说明一键安装。  
   With a DMG: open it and drag **WLSAPlus** into Applications, or follow any install script included in the release.
3. 原生正式包发布后，应用内「检查更新」也会走同一通道。  
   After a native stable release is published, in-app “Check for updates” uses the same channel.

### 关于自签名 · About the self-signed build

开发与部分发布构建使用 ad-hoc 或项目固定证书签名，**未必经过 Apple 公证**。首次打开若提示「无法验证开发者」或「已损坏」：  
Dev and some release builds are ad-hoc or project-certificate signed and **may not be notarized**. If macOS says it "can't be verified" or "is damaged":

- 在「应用程序」里对 WLSAPlus **右键 → 打开 → 打开**；或「系统设置 → 隐私与安全性 → 仍要打开」。  
  **Right-click → Open** in Applications, or *System Settings → Privacy & Security → Open Anyway*.
- 或在终端执行 / or run in Terminal:

```bash
sudo xattr -cr /Applications/WLSAPlus.app
```

## 从源码构建 · Build from source（仅开发者 / developers only）

> 普通用户请用上方 **Download 2.0.0 DMG**，不要走源码编译。
> End users: use the DMG download above — do not build from source.


### 原生应用（当前支持路径）· Native app (supported path)

在安装了 Xcode 命令行工具的 Mac 上：

```bash
cd native
bash scripts/test.sh
bash scripts/build.sh
open out/WLSAPlus.app
```

生成的应用为 universal（arm64 + x86_64）。发布与更新清单准备见 [native/README.md](native/README.md) 中的 `scripts/release.sh` 与根目录 GitHub Actions **Build and release native macOS app**。

On a Mac with Xcode Command Line Tools: run the commands above. The app is universal (arm64 + x86_64). Packaging and update-manifest prep are documented in [native/README.md](native/README.md) (`scripts/release.sh` and the root **Build and release native macOS app** workflow).

### 历史 Electron 树（仅迁移 / 兼容 / 权利记录）· Legacy Electron tree (migration / compat / history only)

仓库根目录仍保留旧版 Electron + Angular Material 源码与 `npm` 脚本，供**数据迁移、更新兼容测试与历史权利记录**使用。**新应用不打包旧 Electron 运行时或旧 VPN 内核**；日常构建与发布请走 `native/`。

The repo root still keeps the former Electron + Angular Material tree and `npm` scripts for **migration, update-compatibility tests, and historical rights records**. **The new app does not ship the old Electron runtime or the old VPN core.** Day-to-day builds and releases use `native/`.

历史开发命令（仅旧树，非当前产品路径）· Historical commands (legacy tree only, not the supported product path):

```bash
# Node.js 22（见 .nvmrc）· Node.js 22 (see .nvmrc)
npm install
npm start                # 界面开发服务器 · renderer dev server
npm test                 # 单元测试 · unit tests (Angular + Electron main)
npm run build:web        # 生产界面构建 · production renderer build
npm run electron:dev     # 开发服务器 + Electron · dev server + Electron
npm run electron:make    # 旧版 macOS universal DMG / ZIP · legacy universal DMG / ZIP
```

旧版 VPN 内核曾使用随仓库分发的 **mihomo（Clash Meta）** universal 二进制（`electron/bin/mac-vpn.tar.gz`）。原生版已改为自研网络栈，构建与发布不再依赖该内核。  
The legacy VPN core used a shipped **mihomo (Clash Meta)** universal binary (`electron/bin/mac-vpn.tar.gz`). The native edition uses its own network stack and no longer depends on that core for build or release.

## 开发 · Development

| 路径 Path | 说明 Description |
|---|---|
| [`native/`](native/) | **当前支持的原生应用**（Swift / C、本地 WebKit UI）· **Supported native app** (Swift / C, local WebKit UI) |
| 仓库根目录 Repo root (`src/`, `electron/`, …) | 历史 Electron 实现 · Legacy Electron implementation |

CI：

- **Native check**（`native-check.yml`）：原生相关检查。  
  Native-related checks.
- **Build and release native macOS app**（`release.yml`）：手动或标签触发，从 `native/` 构建并发布；稳定版可先出草稿，确认后再设为 Latest。  
  Manual or tag-triggered build/publish from `native/`; stable releases may start as drafts, then be marked Latest after acceptance.

可选签名 / 公证 Secrets（与正式发布相关）· Optional signing / notarization secrets:

| 用途 Purpose | Secrets |
|---|---|
| 签名 Signing | `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_IDENTITY` |
| 公证 Notarization | `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` |
| 应用内更新签名 Update signing | `WLSAPLUS_UPDATE_ED25519_KEY`（及既有更新相关配置） |

### PowerSchool 网络录制（开发用）· PowerSchool capture (dev only)

```bash
npx playwright install chromium
npm run record:powerschool -- --url "https://your-school-powerschool.example.com/" --duration 90
```

会脱敏密码 / Cookie，但捕获仍可能含隐私，**禁止公开**；结果在 `captures/`（已 gitignore）。  
Passwords and cookies are redacted, but captures may still contain personal data — **never publish them** (`captures/` is gitignored).

## 隐私 · Privacy

- 课表、成绩、待办保存在本机；PowerSchool 密码用系统 Keychain / 系统加密存储。  
  Schedule, grades and to-dos stay on your Mac; the PowerSchool password is stored with Keychain / OS encryption.
- 论坛自动登录只把当前 PowerSchool 会话 Cookie（白名单）交给论坛服务器做一次性验证，不发送密码；论坛在隔离的 WebKit 数据存储中运行。  
  Forum auto sign-in sends only whitelisted PowerSchool session cookies for a one-time check (never the password); the forum runs in an isolated WebKit data store.

## 许可证 · License

源代码以 **Apache License 2.0** 发布，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。第三方许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。  
Source code is released under **Apache License 2.0** ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)). Third-party notices: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

原生工程的来源与权利边界说明见 [`native/PROVENANCE.md`](native/PROVENANCE.md)。历史 Electron 树中仍可能引用随旧版分发的组件许可证（例如 [`electron/bin/LICENSE-mihomo.txt`](electron/bin/LICENSE-mihomo.txt)）；**原生应用不再分发该内核**。  
Provenance for the native tree: [`native/PROVENANCE.md`](native/PROVENANCE.md). The legacy Electron tree may still reference licenses for components that shipped with older builds (e.g. [`electron/bin/LICENSE-mihomo.txt`](electron/bin/LICENSE-mihomo.txt)); **the native app does not redistribute that core**.

## License

Apache License 2.0. See `LICENSE`. The native VPN/packet stack is original Swift/C and is not derived from mihomo, clash, sing-box, or gVisor.
