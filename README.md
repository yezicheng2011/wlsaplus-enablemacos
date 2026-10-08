<p align="center">
  <img src="public/icons/app-icon.svg" width="96" alt="WLSAPlus">
</p>

<h1 align="center">WLSAPlus · macOS</h1>

<p align="center">
  面向 WLSA 学生的本地优先课表与学业工具 · A local-first schedule &amp; study app for WLSA students<br>
  <b>macOS 13+ · Universal（Intel x86_64 + Apple 芯片 arm64）</b> · Electron + Angular Material · GPL-3.0
</p>

<p align="center">
  <a href="https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/latest">下载 / Download</a> ·
  <a href="#安装--install">安装 / Install</a> ·
  <a href="#从源码构建国内镜像--build-from-source-china-mirrors">从源码构建 / Build</a> ·
  <a href="#开发--development">开发 / Development</a>
</p>

---

## 简介 · About

WLSAPlus 把 PowerSchool 课表、成绩、考勤、开课提醒、校园工具和 WLSAPlus 论坛放进一个原生 Mac 应用。数据保存在本机，离线也能查看上一次同步的内容。

WLSAPlus brings your PowerSchool schedule, grades, attendance, class reminders, campus tools and the WLSAPlus forum into one native Mac app. Data stays on your Mac, and the last sync is available offline.

> 本仓库是 **仅 macOS** 的分支：已移除 Android / Windows 打包与手机中继。
> This fork targets **macOS only**; Android / Windows packaging and the phone relay were removed.

## 功能 · Features

| | 中文 | English |
|---|---|---|
| 💬 **WLSAPlus 论坛**（1.0.9 新增） | 论坛内嵌在应用里；已同步 PowerSchool 时**自动登录**（只转交当前会话，密码不出本机，帖子仍匿名）；**浅色/深色跟随应用主题**并即时切换；嵌入模式使用论坛**底部导航**，宽窗口内容居中 | Embedded forum tab; **auto sign-in** with your current PowerSchool session (password never leaves the Mac, posts stay anonymous); **light/dark follows the app theme** live; embed mode with the forum's **bottom navigation** |
| 📅 **课表 Schedule** | 从 PowerSchool 同步，本地缓存，离线可看 | Synced from PowerSchool, cached locally, works offline |
| 📈 **成绩 Progress** | 课程等级、作业分数、考勤 | Course grades, assignment scores, attendance |
| 🔔 **开课提醒 Reminders** | 开课前约 5 分钟 macOS 通知（可关） | macOS notification ~5 min before class (optional) |
| 🛡️ **VPN** | 订阅节点选择、延迟测速、全设备隧道、微信连通检测 | Subscription nodes, latency test, full-device tunnel, WeChat reachability check |
| 🧰 **工具 Tools** | 校园地图、翻译（含 OCR）、待办 | Campus map, translator (with OCR), to-dos |
| 🎨 **外观 Appearance** | 跟随系统 / 浅色 / 深色，多种主题色 | System / light / dark, multiple accent colours |

## 安装 · Install

**系统要求 / Requirements:** macOS 13 或更新；**universal（通用）构建**，同一个 WLSAPlus.app 同时支持 **Intel（x86_64）与 Apple 芯片（arm64）** Mac。
macOS 13+; a single **universal** WLSAPlus.app runs natively on **both Intel (x86_64) and Apple-silicon (arm64)** Macs.

1. 到 [Releases](https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/latest) 下载最新版本。
   Download the latest version from [Releases](https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/latest).
2. 有 DMG 时：打开 DMG，把 **WLSAPlus** 拖进「应用程序」；有 `安装wlsaplus.command` 时直接双击它一键安装。
   With a DMG: open it and drag **WLSAPlus** into Applications, or double-click `安装wlsaplus.command` if provided.
3. 只有构建包 `wlsaplus1.0.9.zip` 时：见下方「从源码构建」。
   With the build kit `wlsaplus1.0.9.zip`: see *Build from source* below.

### 关于自签名 · About the self-signed build

应用使用 ad-hoc 自签名，**未经过 Apple 公证**。首次打开若提示「无法验证开发者」或「已损坏」：
The app is ad-hoc self-signed and **not notarized**. If macOS says it "can't be verified" or "is damaged":

- 在「应用程序」里对 WLSAPlus **右键 → 打开 → 打开**；或「系统设置 → 隐私与安全性 → 仍要打开」。
  **Right-click → Open** in Applications, or *System Settings → Privacy & Security → Open Anyway*.
- 或在终端执行 / or run in Terminal:

```bash
sudo xattr -cr /Applications/WLSAPlus.app
```

## 从源码构建（国内镜像）· Build from source (China mirrors)

Release 中的 **`wlsaplus1.0.9.zip`** 是一键构建包，解压后包含：
The **`wlsaplus1.0.9.zip`** build kit in Releases contains:

| 文件 File | 说明 Description |
|---|---|
| `working.command` | 双击即可：安装依赖 → 构建 → 签名 → 解除隔离 · Double-click: install deps → build → sign → unquarantine |
| `note.pdf` / `note.md` | 中文说明书 · Chinese guide |
| `wlsaplusformacos/` | 本仓库源码（git 克隆）· This repo (git clone) |

`working.command` 在全新的 Mac（Intel 或 Apple 芯片，macOS 13+）上会自动：
On a fresh Mac (Intel or Apple silicon, macOS 13+), `working.command` will:

1. 检查/安装 Xcode 命令行工具（Apple 官方）· Check / install Xcode Command Line Tools (from Apple)
2. 从 **Gitee**（`gitee.com/mirrors/nvm`，固定版本）安装 nvm，从 **npmmirror** 安装 Node.js 22 · nvm (pinned tag) via **Gitee**, Node.js 22 via **npmmirror**
3. 仅当 nvm 失败时才安装 Homebrew（**清华 TUNA**，失败换 **中科大 USTC**）· Homebrew only as a fallback if nvm fails (**TUNA**, then **USTC**)
4. npm / Electron 均走 **npmmirror** · npm and Electron downloads via **npmmirror**
5. 构建 universal（Intel + Apple 芯片）应用（`electron-forge package --arch universal`，校验 `lipo -archs` 同时含 `x86_64` 与 `arm64`）→ ad-hoc 签名 → `xattr -cr` → 生成 `wlsaplus<版本>.dmg` 并打开
   Build the universal (Intel + Apple silicon) app (`--arch universal`, verified with `lipo -archs` to contain both `x86_64` and `arm64`) → ad-hoc sign → `xattr -cr` → create `wlsaplus<version>.dmg` and open it

macOS 版的 VPN 内核是 **mihomo（Clash Meta）universal 通用二进制**（同时含 arm64 与 x86_64），已在源码 `electron/bin/mac-vpn.tar.gz` 中，构建时不下载任何 VPN 内核，也无需访问境外网站。
The macOS VPN core is a **universal mihomo (Clash Meta) binary** (arm64 + x86_64), already in the source at `electron/bin/mac-vpn.tar.gz`; the build downloads no VPN cores and needs no overseas sites.

## 开发 · Development

```bash
# Node.js 22（见 .nvmrc）· Node.js 22 (see .nvmrc)
npm install
npm start                # 界面开发服务器 · renderer dev server at http://localhost:4200
npm test                 # 单元测试 · unit tests (Angular + Electron main)
npm run build:web        # 生产界面构建（打包前必需）· production renderer build (needed before packaging)
npm run electron:dev     # 开发服务器 + Electron · dev server + Electron
npm run electron:make    # macOS universal DMG / ZIP（需在 macOS 上）· build universal DMG / ZIP (on macOS)
```

- 可安装包在 `out/make`；`dist/` 只是界面（renderer）构建产物。· Installers land in `out/make`; `dist/` is only the renderer build.
- asar 只打包主进程运行时依赖与 `dist/` UI（见 `forge.config.cjs` 的 `RUNTIME_NODE_MODULES`）。
  The asar ships only main-process runtime deps plus the `dist/` UI (see `RUNTIME_NODE_MODULES` in `forge.config.cjs`).
- `package.json` 的 `overrides` 把 `@electron/node-gyp` 固定为 npm 上的 `10.2.0-electron.1`：否则 `@electron/rebuild` 会从 GitHub 拉取 node-gyp（国内常失败），请勿删除。
  The `overrides` entry in `package.json` pins `@electron/node-gyp` to the npm-published `10.2.0-electron.1`, so `@electron/rebuild` does not fetch node-gyp from GitHub (often unreachable in China). Do not remove it.
- 论坛配置集中在 `src/app/core/forum.config.ts`（与 `electron/forum-config.cjs` 同步，有测试校验）。
  Forum settings live in `src/app/core/forum.config.ts`, mirrored in `electron/forum-config.cjs` (kept in sync by tests).

### CI

- **Build macOS universal self-signed DMG**（手动触发）：构建并深度 ad-hoc 签名的 universal（Intel + Apple 芯片）DMG，产物在 Actions artifact。
  *Build macOS universal self-signed DMG* (manual): builds a deep ad-hoc-signed universal (Intel + Apple silicon) DMG as an Actions artifact.
- **Build and release**：推送 `v*` 标签或手动触发，构建并发布到 Release；可选签名/公证密钥：
  *Build and release*: on `v*` tags or manually; optional signing / notarization secrets:

| 用途 Purpose | Secrets |
|---|---|
| 签名 Signing | `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_IDENTITY` |
| 公证 Notarization | `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` |

### PowerSchool 网络录制（开发用）· PowerSchool capture (dev only)

```bash
npx playwright install chromium
npm run record:powerschool -- --url "https://your-school-powerschool.example.com/" --duration 90
```

会脱敏密码 / Cookie，但捕获仍可能含隐私，**禁止公开**；结果在 `captures/`（已 gitignore）。
Passwords and cookies are redacted, but captures may still contain personal data — **never publish them** (`captures/` is gitignored).

## 隐私 · Privacy

- 课表、成绩、待办保存在本机；PowerSchool 密码用系统加密存储。
  Schedule, grades and to-dos stay on your Mac; the PowerSchool password is stored with OS encryption.
- 论坛自动登录只把当前 PowerSchool 会话 Cookie（白名单）交给论坛服务器做一次性验证，不发送密码；论坛在独立的会话分区中运行。
  Forum auto sign-in sends only whitelisted PowerSchool session cookies for a one-time check (never the password); the forum runs in its own isolated session partition.

## 许可证 · License

源代码以 **GNU GPL v3** 发布，见 [`LICENSE`](LICENSE)。第三方许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 以及：
Source code is released under **GNU GPL v3** ([`LICENSE`](LICENSE)). Third-party notices: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and

- [`electron/bin/LICENSE-mihomo.txt`](electron/bin/LICENSE-mihomo.txt)（`electron/bin/mac-vpn.tar.gz` 中的 mihomo / Clash Meta 核心，随应用分发 · mihomo / Clash Meta core, shipped in the app）
