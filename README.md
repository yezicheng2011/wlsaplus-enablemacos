<p align="center">
  <img src="public/icons/app-icon.svg" width="96" alt="WLSAPlus">
</p>

<h1 align="center">WLSAPlus · macOS</h1>

<p align="center">
  面向 WLSA 学生的本地优先课表与学业工具 · A local-first schedule &amp; study app for WLSA students<br>
  <b>macOS · Apple Silicon (M1/M2/M3/M4…)</b> · Electron + Angular Material · GPL-3.0
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

PowerSchool 同步只在桌面应用内可用（浏览器版受学校 CORS 限制）。
PowerSchool sync works in the desktop app only (the browser build is blocked by the school's CORS policy).

## 安装 · Install

**系统要求 / Requirements:** Apple 芯片 Mac（Intel 不支持）· Apple-silicon Mac (Intel not supported).

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

`working.command` 在全新的 Apple 芯片 Mac 上会自动：
On a fresh Apple-silicon Mac, `working.command` will:

1. 检查/安装 Xcode 命令行工具（Apple 官方）· Check / install Xcode Command Line Tools (from Apple)
2. 从 **清华 TUNA** 镜像安装 Homebrew · Install Homebrew from the **TUNA** mirror
3. 从 **Gitee（nvm-cn）** 安装 nvm，从 **npmmirror** 安装 Node.js 22 · nvm via **Gitee (nvm-cn)**, Node.js 22 via **npmmirror**
4. npm / Electron 均走 **npmmirror** · npm and Electron downloads via **npmmirror**
5. 构建 arm64 应用 → ad-hoc 签名 → `xattr -cr` → 生成 `wlsaplus<版本>.dmg` 并打开
   Build the arm64 app → ad-hoc sign → `xattr -cr` → create `wlsaplus<version>.dmg` and open it

VPN 内核（sing-box / v2ray-plugin，arm64）已随构建包放在 `wlsaplusformacos/build/vpn-core/`，构建时无需访问境外网站。
The VPN cores (sing-box / v2ray-plugin, arm64) are bundled in the kit under `wlsaplusformacos/build/vpn-core/`, so no overseas downloads are needed.

## 开发 · Development

```bash
# Node.js 22（见 .nvmrc）· Node.js 22 (see .nvmrc)
npm install
npm start                # 浏览器 UI 开发 · UI dev server at http://localhost:4200
npm test                 # 单元测试 · unit tests (Angular + Electron main)
npm run build:web        # 生产前端 · production web build
npm run electron:dev     # 开发服务器 + Electron · dev server + Electron
npm run electron:make    # macOS DMG / ZIP（需在 macOS 上）· build DMG / ZIP (on macOS)
```

- 可安装包在 `out/make`；`dist/` 只是前端产物。· Installers land in `out/make`; `dist/` is only the web build.
- asar 只打包主进程运行时依赖与 `dist/` UI（见 `forge.config.cjs` 的 `RUNTIME_NODE_MODULES`）。
  The asar ships only main-process runtime deps plus the `dist/` UI (see `RUNTIME_NODE_MODULES` in `forge.config.cjs`).
- 论坛配置集中在 `src/app/core/forum.config.ts`（与 `electron/forum-config.cjs` 同步，有测试校验）。
  Forum settings live in `src/app/core/forum.config.ts`, mirrored in `electron/forum-config.cjs` (kept in sync by tests).

### CI

- **Build macOS arm64 self-signed DMG**（手动触发）：构建并深度 ad-hoc 签名的 arm64 DMG，产物在 Actions artifact。
  *Build macOS arm64 self-signed DMG* (manual): builds a deep ad-hoc-signed arm64 DMG as an Actions artifact.
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

- [`build/vpn-core/LICENSE-sing-box.txt`](build/vpn-core/LICENSE-sing-box.txt)
- [`build/vpn-core/LICENSE-v2ray-plugin.txt`](build/vpn-core/LICENSE-v2ray-plugin.txt)
- [`build/vpn-core/LICENSE-mihomo.txt`](build/vpn-core/LICENSE-mihomo.txt)（`electron/bin/mac-vpn.tar.gz` 中的 mihomo / Clash Meta 核心 · mihomo / Clash Meta core）
