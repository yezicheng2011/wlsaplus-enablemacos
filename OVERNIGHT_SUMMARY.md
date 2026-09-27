# 过夜修复摘要（Asia/Shanghai）

时间：2026-09-27 夜间（基于 tip `9380743` 继续）

## 已推送目标

- 仓库：`yezicheng2011/wlsaplus-enablemacos` → `origin/main`
- **未发布** GitHub Release `1.0.9`（保持 draft）
- 未 force-push；保留国内镜像（npmmirror / gitee / gh-proxy）

## 已推送 commits（main）

- `32e7cfb` Fix Forge packaging: prune:false so RUNTIME allow-list applies
- `3b9aeaa` Fix Mac VPN disconnect and null Clash profile crash
- `e340d57` Harden renderer APIs: timeouts, macOS-only VPN, safer reminders
- `227f2ee` Document out/make packaging and gate release-kit on loadFile fix

## 提交与修复

### A) 启动 / 白屏与打包

- `forge.config.cjs`：设置 **`prune: false`**。原先 `prune: true` 会按 `package.json` 生产依赖走打包，**绕过** `ignore()` 对 module root 的过滤，把 Angular / tesseract 等塞进 asar。
- 规范化 ignore 路径（兼容有无前导 `/`）。
- 在 Linux 上 `electron-forge package` 验证：asar 含 `dist/.../index.html`、`electron-updater`、`js-yaml`；**不再**含 `tesseract.js` / `rxjs` / `@angular/*`。
- `release-kit/构建wlsaplus.command`：额外要求祖先提交 `fdd798b`（`loadFile`），并保留 `2ea0edc` 检查与国内镜像。

### B) Bug 修复

- **Mac VPN 断开**：`disconnectVpn` 以前只停 `vpnProcess`（sing-box），真正的 elevated clash helper 会残留。现增加 `stopMacClashHelper`（先无提权 `pkill`，再必要时 osascript）；取消授权则保持 connected。
- **重连前**尽力停掉旧 clash，避免叠隧道。
- **`fetchVpnProfile`**：`document` 为 null 时访问 `document.proxies` 会崩；改为安全访问，无 Clash 文档时走 SS 回退。
- **开课提醒**：通知调用改为局部变量 + optional，避免空引用。
- **`supportsVpn`**：仅 `macos`（去掉 windows 残留）。
- 补测：`electron/forge-ignore.test.cjs`、`electron/vpn-profile.test.cjs`；修正 `local-store` / `platform` 规格中与 `classRemindersEnabled`、AbortSignal 相关的断言；`vpn-config` 测试在非 Windows 也可检测 `sing-box`。

### C) Links / API

- 外部 URL 探测（超时 12s）：帮助文、VPN 订阅、微信、更新镜像 latest.yml、notice、PowerSchool、国内镜像均可达；translate 接口对本机 IP 返回 429（客户端已有 Google→MyMemory 回退 + 超时）。
- 统一超时：主进程 translate / PowerSchool IPC；渲染进程 notice、web gateway、MyMemory。
- VPN `list-nodes` 错误信息更清晰；latency 失败在 UI 侧展示。
- **未改** China mirror URL；update feed 仍指向 `DDguan2010/wlsaplus` + gh-proxy（既有设计）。

### D) 安全优化

- 无功能裁剪：PowerSchool / Progress / 提醒 / VPN 节点 UI 保留。
- README 补充 `out/make` vs `dist/` 与 asar 白名单说明。

## 已验证

- `npm test`（ng vitest + `electron/*.test.cjs`）通过
- `npm run build:web` 通过
- `electron-forge package`（linux）asar 内容符合 RUNTIME 白名单
- **未能**在真实 macOS GUI 上跑 VPN / Notification / DMG（本环境为 Linux）

## 剩余 Mac-only 风险（诚实）

1. **VPN disconnect 提权**：停 root clash 可能再弹一次管理员密码；用户取消则保持连接——需真机确认体验。
2. **TUN / clash 行为**：节点选择、延迟、微信探测逻辑可测，但真实网络与授权对话框只能在 Mac 上验证。
3. **开课提醒**：依赖 macOS Notification 权限；逻辑已硬化，权限弹窗未在本机验证。
4. **PowerSchool**：网关根路径对外 403；HTTPS 学校站可探，完整登录同步需真实账号。
5. **自动更新**：macOS 构建里 `updatesSupported` 仍为 false（仅 win32 打包启用）——属既有策略，非本次引入。
6. **翻译 API 429**：公共接口限流；已有超时与回退，高峰仍可能失败。

## 草稿 Release

- `1.0.9` 保持 **draft / unpublished**；正文可同步过夜修复说明，**不上传资产、不 publish**。
