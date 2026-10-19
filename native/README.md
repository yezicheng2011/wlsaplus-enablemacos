# WLSAPlus 原生重写

这是独立编写的新工程，使用 macOS 13+ 系统框架与 Apple 编译工具。当前处于验证阶段，不能把通过离线测试等同于完成了所有真实 Mac 场景验收。

界面保持 Home、Schedule、Progress、Forum、Tools、Settings 的功能入口。WebKit 仅显示本地 HTML/CSS/JavaScript；账号、文件、网络、通知、VPN 与更新由 Swift/C 实现。没有 npm、Swift Package、第三方 VPN 内核或第三方运行时依赖。

## 构建和检查

在安装 Xcode 命令行工具的 Mac 上运行：

```sh
bash scripts/test.sh
bash scripts/build.sh
open out/WLSAPlus.app
```

生成的应用同时包含 arm64 和 x86_64。开发构建使用 ad-hoc 签名；正式更新包必须使用原有固定证书与更新密钥。

Linux 可以运行 C 数据包引擎、JavaScript 与 Swift Core 测试。Linux 的 Swift 语法检查不验证 Apple SDK 类型或系统行为，不能代替 macOS 构建。

Mac CI 已通过双架构构建、实际 WebKit 界面/原生桥接/课表解析器启动、现有 VMess 节点的真实隧道流量与网络恢复，以及原密钥和固定证书下的更新兼容检查。首次完整通过记录见 [Mac CI15](https://github.com/yezicheng2011/wlsaplus-enablemacos/actions/runs/39216072417)。这些是列明场景的验证，不能等同于全部功能与网络环境验收。

## VPN

继续从原有订阅地址读取节点，支持该订阅声明的 Shadowsocks AES-256-GCM、VMess 旧版与 AEAD 认证，以及 TCP、TLS、WebSocket 和 UDP。加密调用 CryptoKit/CommonCrypto，网络调用 Network.framework，隧道使用系统 utun。协议与数据包处理代码为本工程新写，没有链接或分发 mihomo、gVisor、sing-box、WireGuard 等实现。

本地 TCP 端点包含校验和、序列与确认、乱序缓冲、窗口、重传、FIN/RST，以及有界 IPv4/IPv6 分片重组。它仍是需要实际压力与互通验证的新实现：每个实例最多 128 个流，不协商窗口扩展/SACK/时间戳，不转发 ICMP 或 IPsec。详见 `Sources/Packet/README.md`。

提权辅助进程只有在协议出口验证、utun 配置、路由/DNS 事务及经隧道的 HTTPS 验证完成后才报告已连接。它监测父进程和物理网络变化，断开时恢复路由与 DNS；恢复失败会保留恢复日志并阻止安装更新。首次启动和连接会需要 macOS 管理员授权。

真实节点抽测使用独立测试实现验证了 4 个现有 VMess TCP/TLS 节点接受主 UUID 的旧版认证。Mac CI 已使用原生客户端和现有 VMess 节点通过 utun、HTTPS 204、UDP DNS、C 引擎 TCP/UDP 流量及双向代理字节检查；随机 DNS 查询还核对了发出、认证响应和成功写回 utun 三个环节。断开后原路由/DNS 与辅助进程退出检查均通过。抽测的 SS 节点及订阅中的两个 WS 节点均在 TCP 建连阶段超时，尚未进入协议协商；不能据此判断这些协议实现是否互通。其他协议/节点及实际用户网络仍需验收。

## 应用内更新兼容

保留原 Bundle ID `cn.org.wlsash.wlsaplus`、产品标识 `wlsaplus-macos`、原 Ed25519 公钥、代码签名证书指纹、更新站点、镜像候选、清单 format=1 与启动确认参数。原版更新器检查的是应用标识、版本、处理器和签名，不要求 Electron 资源，因此可以接受按这些条件正确签名的新原生包。

新实现包括稳定/测试通道、版本与回滚黑名单检查、系统断点续传下载、大小/SHA-256 校验、ZIP 安全检查、代码签名验证、退出前断开 VPN、替换/备份和 90 秒启动确认回滚。新版本仍通过设置中的更新按钮下载和重启安装。

发布准备使用已有 CI secrets（不生成替代密钥）：

```sh
WLSAPLUS_VERSION=2.0.0-beta.1 bash scripts/release.sh
```

需要先导入原固定代码签名证书，并设置 `WLSAPLUS_UPDATE_ED25519_KEY`。输出文件名和清单格式保持旧版兼容。`release.sh` 只在本地准备产物；仓库根目录的发布工作流取代原 Electron 产物流程，稳定版生成草稿，测试版更新现有 beta 通道。稳定草稿验收后发布时须选中「Set as the latest release」（CLI：`gh release edit v版本 --draft=false --latest`），旧版和新版的稳定更新按钮才能发现它。必须在真实 Mac 上验证旧版 1.1.2 → 新版、下次原生版本升级、取消授权、非可写 Applications 目录、断点续传与强制回滚。

`scripts/signed-update-compat.sh` 是可选的签名兼容测试。Mac CI 已用原 secrets 签名测试副本、生成原公钥可验证的清单，并通过原仓库未修改的 1.1.2 更新器完成 arm64/x64 下载、解包、签名、架构及就绪检查；原安装辅助脚本也已通过临时目标替换与新原生应用启动确认。原生安装辅助进程自身也已通过改名的临时 `.app` 从 1.1.2 测试副本到 2.0.0 测试副本的替换、启动确认与备份清理检查。测试不发布产物，使用的是更新器模块和临时目标，不能替代完整旧 Electron 应用的升级验收。单独运行本目录时需将 `WLSAPLUS_LEGACY_ELECTRON_DIR` 指向原仓库的 `electron` 目录，并显式设置 `WLSAPLUS_RUN_SIGNED_COMPAT_SMOKE=1`。

## 功能与数据

PowerSchool 登录使用原服务器公开的 HTML/JSON 接口，密码只存入系统 Keychain，网页解析通过 inert DOM 执行，不运行服务器脚本。保存账号后在启动和每 15 分钟自动同步，后台失败保留缓存，手动操作优先。可识别的假期空课表不会阻止成绩刷新。课表、成绩、作业、考勤、任务与设置保存在本机。通知以真实时间在上课前五分钟触发，不受显示时间模拟影响。

成绩表按分组表头和课程信息识别各列，支持多学期与额外列，成绩、学期和详情链接保持对应。明确选中的学期即使未公布成绩也不会被其他学期替代。文字提取排除隐藏提示并保留可见成绩符号和 HTML 段落间隔；原有错误缓存需重新同步后刷新。

论坛使用隔离的 WebKit 数据存储与主机白名单，支持主题/嵌入协议，以及仅转交允许的 PowerSchool 会话 Cookie 的一次性 SSO。密码不会转交论坛。翻译继续使用现有在线服务接口。校园地图重新绘制为楼宇示意图，包含楼宇资料和教室楼号定位，不声称是精确测绘的楼层平面图。

首次启动会只读解析原 Chromium 本地存储的有效 LevelDB 清单、数据表和日志，迁移课表、成绩、任务、外观与节点选择。迁移会验证校验和、删除记录、压缩格式和文件稳定性；遇到无法安全识别的数据会提示并保留原目录，不猜测或覆盖。合成样本已覆盖迁移逻辑，真实用户数据库仍需验证。旧版账号密码的 Electron 加密格式没有被解密迁移，首次使用原生版需要重新登录。

## 代码来源和权利边界

新代码及素材来源记录见 `PROVENANCE.md`。独立重写与不存在任何第三方知识产权是不同问题；操作系统、编译器、公开协议、服务名称和服务端本身的权利不属于本工程。这里不声明已经完成法律审查、专利检索或可证明的净室开发认证，也不改写原仓库历史代码的版权与许可证。
