# WLSAPlus · macOS

<p align="center">
  <img src="public/icons/app-icon.svg" width="96" alt="WLSAPlus">
</p>

<p align="center">
  面向 WLSA 学生的本地优先课表与学业工具 · A local-first schedule &amp; study app for WLSA students<br>
  <b>macOS 13+ · Universal（Intel x86_64 + Apple silicon arm64）</b> · 原生 Swift / C · Native Swift / C
</p>

<p align="center">
  <a href="#从源码构建--build-from-source">从源码构建 / Build from source</a> ·
  <a href="release-kit/wlsaplusmac版本说明书.md">说明书 / Manual</a> ·
  <a href="https://wlsaplus.spacehubxyz.hk/#download">官网 / Official site</a> ·
  <a href="native/README.md">原生工程说明 / Native docs</a>
</p>

> **当前产品形态 · Current product**  
> macOS 客户端已全面重写为独立原生应用（Swift / C；系统 AppKit、WebKit、Network、CryptoKit 等）。  
> The macOS client has been fully rewritten as an **independent native** app (Swift / C; system AppKit, WebKit, Network, CryptoKit, and related frameworks).  
>  
> **与其他平台 · Other platforms**  
> macOS 版为独立产品线，与 Windows / Android 版**互不相通**（不共用代码与运行时）。  
> This macOS edition is an independent product line and does **not** share code or runtime with Windows / Android.  
>  
> **网络与 VPN 核心 · Network & VPN core**  
> VPN 内核为**自研开源的 MockMini**（[Apache-2.0](LICENSE)；主站 [mockmini.danielye2011.uk](https://mockmini.danielye2011.uk/)），基于系统 utun + Network.framework + CryptoKit/CommonCrypto，**不再使用**旧版共用内核（mihomo / Clash Meta）或第三方 VPN 运行时。  
> The VPN core is **self-developed open-source MockMini** (Apache-2.0; site [mockmini.danielye2011.uk](https://mockmini.danielye2011.uk/)), built on system utun + Network.framework + CryptoKit/CommonCrypto — **not** the former shared core (mihomo / Clash Meta) or a third-party VPN runtime.  
>  
> **安装方式 · How to install（重要）**  
> **普通用户请按说明书从源码编译安装**（见下方「从源码构建」与 [说明书](release-kit/wlsaplusmac版本说明书.md)）。仓库 Releases 中的包主要用于开发者自测与应用内更新通道，**不是**面向同学的一键安装主路径。  
> **End users should build from source** using the steps below and the [manual](release-kit/wlsaplusmac版本说明书.md). GitHub Releases are mainly for developer self-test and the in-app update channel — **not** the primary install path for classmates.

---

## 简介 · About

WLSAPlus 把 PowerSchool 课表、成绩、考勤、开课提醒、校园工具和 WLSAPlus 论坛放进一个原生 Mac 应用。数据保存在本机，离线也能查看上一次同步的内容。

WLSAPlus brings your PowerSchool schedule, grades, attendance, class reminders, campus tools and the WLSAPlus forum into one native Mac app. Data stays on your Mac, and the last sync is available offline.

> 本仓库仅提供 **macOS** 客户端；与 Windows / Android 版本相互独立。  
> This repository ships the **macOS** client only; it is independent of the Windows and Android editions.

## 功能 · Features

| | 中文 | English |
|---|---|---|
| 💬 **WLSAPlus 论坛** | 论坛内嵌在应用里；已同步 PowerSchool 时**自动登录**（只转交当前会话，密码不出本机，帖子仍匿名）；**浅色/深色跟随应用主题**；嵌入模式使用论坛**底部导航** | Embedded forum; **auto sign-in** with the current PowerSchool session (password never leaves the Mac; posts stay anonymous); **light/dark follows the app theme**; embed mode with the forum **bottom navigation** |
| 📅 **课表 Schedule** | 从 PowerSchool 同步，本地缓存，离线可看 | Synced from PowerSchool, cached locally, works offline |
| 📈 **成绩 Progress** | 课程等级、作业分数、考勤 | Course grades, assignment scores, attendance |
| 🔔 **开课提醒 Reminders** | 开课前约 5 分钟 macOS 通知（可关） | macOS notification ~5 min before class (optional) |
| 🛡️ **VPN** | 订阅节点、延迟测速、全设备隧道；内核为**自研开源的 MockMini**（Apache-2.0） | Subscription nodes, latency test, full-device tunnel; core is **self-developed open-source MockMini** (Apache-2.0) |
| 🧰 **工具 Tools** | 校园地图、翻译、待办 | Campus map, translator, to-dos |
| 🎨 **外观 Appearance** | 跟随系统 / 浅色 / 深色，多种主题色 | System / light / dark, multiple accent colours |

## 从源码构建 · Build from source

**这是普通用户的推荐安装方式。** 不需要 Apple 开发者账号，不需要 Node / npm / Homebrew（日常编译也不需要）。

**This is the recommended install path for classmates.** No Apple Developer account, and no Node / npm / Homebrew for a normal build.

### 系统要求 · Requirements

- macOS **13** 或更新（Intel 与 Apple 芯片均可）
- 已安装 **Xcode 命令行工具**（若未装，在终端执行 `xcode-select --install`，按提示完成）

### 推荐命令（复制整段）· Commands

国内网络优先用 **gh-proxy.com** 镜像克隆（勿与常被墙的 `ghproxy.com` 混淆）。备选把主机换成 `ghproxy.net` 或 `ghfast.top`（路径不变）。

```bash
# 1) 克隆仓库（推荐国内镜像）
git clone https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos.git
cd wlsaplus-enablemacos

# 2) 进入原生工程并编译（universal：arm64 + x86_64）
cd native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh

# 3) 打开刚编好的应用
open out/WLSAPlus.app
```

同学可复制的核心四行（镜像 clone + 编译 + 打开）：

```bash
git clone https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos.git
cd wlsaplus-enablemacos/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

若 `git clone` 仍失败，用同一镜像下载 zip：

```bash
curl -L -o wlsaplus-enablemacos.zip 'https://gh-proxy.com/https://github.com/yezicheng2011/wlsaplus-enablemacos/archive/refs/heads/main.zip'
unzip wlsaplus-enablemacos.zip
cd wlsaplus-enablemacos-main/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

能直连 GitHub 时也可改用 `https://github.com/yezicheng2011/wlsaplus-enablemacos.git`。

可选：装进「应用程序」，并去掉隔离标记（减少「已损坏」误报）：

```bash
ditto out/WLSAPlus.app /Applications/WLSAPlus.app
xattr -cr /Applications/WLSAPlus.app
open /Applications/WLSAPlus.app
```

更省事：克隆后也可双击仓库里的 [`release-kit/编译wlsaplus.command`](release-kit/编译wlsaplus.command)（会检查命令行工具 → 编译 → 打开应用）。完整中文步骤见 [说明书](release-kit/wlsaplusmac版本说明书.md)。

### 首次打开提示「无法验证开发者 / 不安全」· Gatekeeper

构建默认使用 **ad-hoc / 项目自签名**，**不需要也不要求** Apple Developer ID 或公证。别人打开时一般会提示「无法验证开发者」或「不安全」，**按下面做即可**（这是预期行为，不是编译失败）：

- 在访达里对 `WLSAPlus.app` **右键 → 打开 → 打开**；或「系统设置 → 隐私与安全性 → 仍要打开」
- 若仍提示「已损坏」，在终端执行：

```bash
xattr -cr /Applications/WLSAPlus.app
# 若应用还在 out/ 目录：
# xattr -cr "$(pwd)/out/WLSAPlus.app"
```

### 可选：跑测试 · Optional tests

完整测试需要本机另有 `node` 与 `python3`（日常装应用**不必**跑）：

```bash
cd native
bash scripts/test.sh
```

### 历史 Electron 树（仅迁移 / 兼容 / 权利记录）· Legacy Electron tree

仓库根目录仍保留旧版 Electron + Angular Material 与 `npm` 脚本，供数据迁移、更新兼容与历史权利记录。**新应用不打包旧 Electron 运行时或旧 VPN 内核**；日常安装与发布请走 `native/` 上述命令，**不要**再按旧版 `npm install` / `npm run electron:make` 给同学装。

Legacy Electron commands (not the supported product path):

```bash
# Node.js 22（见 .nvmrc）——仅旧树 / legacy tree only
npm install
npm run electron:make
```

## 开发 · Development

| 路径 Path | 说明 Description |
|---|---|
| [`native/`](native/) | **当前支持的原生应用**（Swift / C、本地 WebKit UI） |
| 仓库根目录（`src/`、`electron/`…） | 历史 Electron 实现 · Legacy only |

CI：

- **Native check**（`native-check.yml`）
- **Build and release native macOS app**（`release.yml`）：从 `native/` 构建；稳定版可先草稿再设为 Latest（供应用内更新）

可选签名 / 公证 Secrets（维护者发布用，普通同学编译不需要）：

| 用途 | Secrets |
|---|---|
| 签名 | `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_IDENTITY` |
| 公证 | `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` |
| 应用内更新签名 | `WLSAPLUS_UPDATE_ED25519_KEY` |

细节见 [native/README.md](native/README.md) 与 [native/PROVENANCE.md](native/PROVENANCE.md)。

## 隐私 · Privacy

- 课表、成绩、待办保存在本机；PowerSchool 密码用系统 Keychain / 系统加密存储。
- 论坛自动登录只把当前 PowerSchool 会话 Cookie（白名单）交给论坛服务器做一次性验证，不发送密码；论坛在隔离的 WebKit 数据存储中运行。

## 许可证 · License

源代码以 **Apache License 2.0** 发布，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。第三方许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

原生工程的来源与权利边界说明见 [`native/PROVENANCE.md`](native/PROVENANCE.md)。历史 Electron 树中仍可能引用随旧版分发的组件许可证（例如 [`electron/bin/LICENSE-mihomo.txt`](electron/bin/LICENSE-mihomo.txt)）；**原生应用不再分发该内核**。

© daniel.ye
