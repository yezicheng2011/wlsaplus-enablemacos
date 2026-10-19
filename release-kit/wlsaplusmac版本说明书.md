# WLSAPlus macOS 版本说明书（2.0.0）

面向同学的安装方式：**按本文从源码编译**。不需要 Apple 开发者账号，也不需要用官网/GitHub 的一键 DMG 当主路径（那是开发者自测与应用内更新用的）。

© daniel.ye

---

## 这是什么

- **产品**：WLSAPlus macOS 客户端（课表、成绩、考勤、开课提醒、校园工具、论坛、VPN）
- **形态**：macOS **原生**应用（Swift / C），与 Windows / Android 版**相互独立、互不相通**
- **VPN 内核**：**自研开源的 MockMini**（Apache-2.0；说明见 [mockmini.danielye2011.uk](https://mockmini.danielye2011.uk/)），不再使用旧版 mihomo / Clash Meta
- **当前版本**：2.0.0

## 系统要求

- macOS **13** 或更新
- **Intel（x86_64）与 Apple 芯片（arm64）** 都支持（编译产物为 universal）
- 需要安装 **Xcode 命令行工具**（不是完整 Xcode App；体积小很多）
- **不需要**：Homebrew、Node.js、npm、Apple Developer 付费账号

## 安装：从源码编译（推荐）

### 方式 A：终端复制命令（最清楚）

1. 打开「终端」（启动台 → 其他 → 终端）。
2. 若从未装过命令行工具，先执行（弹出窗口按提示安装，装完再继续）：

```bash
xcode-select --install
```

3. 复制执行下面整段：

```bash
git clone https://github.com/yezicheng2011/wlsaplus-enablemacos.git
cd wlsaplus-enablemacos/native
WLSAPLUS_VERSION=2.0.0 bash scripts/build.sh
open out/WLSAPlus.app
```

4. （可选）装进「应用程序」：

```bash
ditto out/WLSAPlus.app /Applications/WLSAPlus.app
xattr -cr /Applications/WLSAPlus.app
open /Applications/WLSAPlus.app
```

编译成功后，应用在 `wlsaplus-enablemacos/native/out/WLSAPlus.app`。

### 方式 B：双击一键编译脚本

若你已经把本仓库克隆到本机：

1. 在访达中打开仓库里的 `release-kit` 文件夹
2. 双击 **`编译wlsaplus.command`**
3. 若提示无法打开：右键 → 打开 → 打开；或先在终端执行 `chmod +x` 后再双击
4. 脚本会检查命令行工具 → 编译 2.0.0 → 打开应用

> 国内若 `git clone` GitHub 较慢，可用你惯用的镜像 / 代理后再克隆；编译本身**不依赖** npm，也不下载境外 Electron / VPN 内核。

## 第一次打开：为什么显示「不安全」而不是「已损坏」

编译产物默认是 **自签名**（ad-hoc），**没有**也不需要 Apple 公证。

- **正常情况**：提示「无法验证开发者」或「不安全」→ 对应用 **右键 → 打开 → 打开**，或到「系统设置 → 隐私与安全性 → 仍要打开」。
- **若仍显示「已损坏」**：多半是隔离属性（从网盘/浏览器拷过来时常见）。在终端执行：

```bash
xattr -cr /Applications/WLSAPlus.app
# 或针对 out 目录里的包：
# xattr -cr /path/to/wlsaplus-enablemacos/native/out/WLSAPlus.app
```

然后再右键打开。同学之间互传时，优先传**自己编译好的 `.app`**，并提醒对方用右键打开；不要指望未公证的包像 App Store 应用一样静默通过。

## 使用说明（功能）

### 课表与成绩

在应用内 Connect / 同步 PowerSchool 后，可在课表与 Progress（成绩、作业、考勤）中查看。数据保存在本机；离线可看上次同步结果。首次从旧 Electron 版迁到 2.0.0 时，**账号密码需要重新登录**（旧加密格式不会自动解密迁移）。

### WLSAPlus 论坛

左侧栏（窗口较窄时为底部栏）的 **Forum** 标签：

- 已同步 PowerSchool 时可**自动登录**（只转交会话，密码不发给论坛；帖子仍匿名）
- 浅色 / 深色跟随应用主题
- 嵌入模式使用论坛底部导航

### VPN（MockMini）

1. 打开 Tools → VPN
2. 可先刷新节点、测延迟，再选中节点
3. 点 Connect；若弹出管理员授权，输入本机密码并允许
4. 断开时先在 VPN 页点 Disconnect（2.0.0 **没有**旧版 `clash` / mihomo 进程，不必再去活动监视器里杀 clash）

### 开课提醒

设置里可开关 Class reminders。开启后，开课前约 5 分钟发 macOS 通知（需已同步课表）。

## 和 1.1.2 / 旧说明书的差别（一眼看懂）

| | 旧版 1.1.2 及更早 | 现在 2.0.0 |
| --- | --- | --- |
| 技术 | Electron + Node + `npm run electron:make` | 原生 Swift/C：`native/scripts/build.sh` |
| 同学怎么装 | 构建包 / `working.command` / 或自备 Node 编译 | **git clone + build.sh**（或 `编译wlsaplus.command`） |
| VPN | mihomo（Clash Meta） | **自研开源的 MockMini**（Apache-2.0） |
| 关 VPN | 还可能要在活动监视器结束 `clash` | 应用内 Disconnect 即可 |

## 常见问题

**Q：可以只下载 DMG、不编译吗？**  
A：面向同学的正式路径是**源码编译**（本文）。GitHub Release / 应用内更新通道上的包供维护与自测；请以本说明书为准。

**Q：编译报错找不到 `xcrun` / `swiftc`？**  
A：先执行 `xcode-select --install`，装完重开终端再编。

**Q：要不要 `npm install`？**  
A：日常装 2.0.0 **不要**。那是旧 Electron 树的命令。

**Q：版权与许可证？**  
A：应用源码 Apache-2.0，见仓库 `LICENSE` / `NOTICE`。© daniel.ye

## 相关链接

- 源码：<https://github.com/yezicheng2011/wlsaplus-enablemacos>
- MockMini：<https://mockmini.danielye2011.uk/>
- 官网：<https://wlsaplus.spacehubxyz.hk/>
