# WLSAPlus（macOS）

面向 WLSA 学生的本地优先课表与学业工具。基于 Angular Material，用 Electron 打包为 **仅支持 macOS** 的桌面应用。

本仓库分支面向 macOS：已去掉 Android / Windows 打包与手机中继相关代码。课表与成绩仍通过 PowerSchool 同步。

## 功能概览

- **课表**：从 PowerSchool 同步日程，本地缓存，离线仍可查看上次快照
- **成绩（Progress）**：课程等级、作业分数、考勤；侧边栏 Progress 入口
- **开课提醒**：开课前约 5 分钟发送 macOS 通知（设置里可开关）
- **校园地图、翻译、待办** 等工具页
- **VPN（macOS）**
  - 从订阅拉取全部节点并选择连接
  - 节点 TCP 延迟测速
  - 连接时授权前的无害中间状态不再误报为失败
  - 微信连通检测（`https://weixin.qq.com/`，VPN 开/关均可测；不等于微信能否登录发消息）

PowerSchool 直连同步仅在 Electron 包内可用；普通浏览器会受学校 CORS 限制。

## 环境要求

- macOS（打包与真机 VPN / 通知需在 Mac 上验证）
- Node.js ≥ 22（见 `.nvmrc`）
- 本地开发：`npm install` 后即可

## 开发

```bash
npm install
npm start
```

浏览器打开 `http://localhost:4200`（仅适合 UI 开发；PowerSchool 同步请用 Electron）。

```bash
npm test
npm run build:web
npm run electron:dev    # 开发服务器 + Electron
npm run electron:start  # 生产前端构建后启动 Electron
npm run electron:make   # 产出 macOS DMG / ZIP（需在 macOS 上执行）
```

原生应用会在启动时、点击同步时，以及打开期间每 15 分钟尝试同步 PowerSchool。同步失败时保留本地上一份数据。

## 发布

在 GitHub：**Actions → Build and release → Run workflow**，填写语义化版本（如 `1.2.0`）。工作流会打上 `v1.2.0` 标签，并把 macOS DMG/ZIP 发到 Release。直接推送 `v*` 标签也可以。

普通分支推送不会触发发布。

可选签名 / 公证密钥：

| 用途 | Secrets |
| --- | --- |
| 签名 | `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_IDENTITY` |
| 公证 | `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` |

未配置时会打出未签名包。

## PowerSchool 网络录制（开发用）

用于调试 PowerSchool 页面请求。会打开临时 Chromium，记录网络元数据与文本响应。密码、Cookie、Authorization 等会脱敏，但捕获仍可能含课程与学生隐私，**禁止公开发布**。

```bash
npm install
npx playwright install chromium
npm run record:powerschool -- --url "https://your-school-powerschool.example.com/" --duration 90
```

省略 `--url` 时会交互询问。时长限制 15–600 秒。结果写在 `captures/powerschool-<timestamp>/`（已 gitignore）。

录制时可手动登录、打开课表、进入一门课再返回、切换周次/学期（若有），等待窗口自动关闭。

## 许可证

本项目源代码以 **GNU GPL v3** 发布，见根目录 [`LICENSE`](LICENSE)。

捆绑与依赖的第三方许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，以及：

- [`build/vpn-core/LICENSE-sing-box.txt`](build/vpn-core/LICENSE-sing-box.txt)
- [`build/vpn-core/LICENSE-v2ray-plugin.txt`](build/vpn-core/LICENSE-v2ray-plugin.txt)
- [`build/vpn-core/LICENSE-mihomo.txt`](build/vpn-core/LICENSE-mihomo.txt)（与 `electron/bin/mac-vpn.tar.gz` 中的 mihomo / Clash Meta 核心对应）

## 仓库说明

- 默认目标平台：**仅 macOS Electron**
- 上游若仍含 Android / Windows，本 fork 已裁剪；请以本 README 与 `forge.config.cjs` 为准
