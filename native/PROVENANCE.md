# 来源记录

本目录的 Swift、C、HTML、CSS、JavaScript、测试与构建脚本是本次任务中新编写的实现。没有复制第三方 VPN 内核、TCP/IP 栈、代理协议库、网页框架、字体、图标库或原仓库实现文件；未分发原内核二进制。图标路径、界面样式与校园楼宇示意图在本工程中绘制。

主实现者阅读了原仓库的接口、数据格式和更新约束以保持兼容；部分子任务仅根据功能说明和公开协议编写。这不构成经过法律审计的净室过程，也不能据此保证不存在任何第三方权利。

允许的运行环境依赖均由 macOS 提供：AppKit、WebKit、Foundation、Network.framework、Security/Keychain、CryptoKit、CommonCrypto、UserNotifications、ServiceManagement、Darwin/utun、系统路由和 DNS 工具。Apple 编译器和系统开发头文件用于构建。系统组件及公开协议不声明为原创技术。

互操作标识（Bundle ID、更新产品名、公钥、证书指纹、订阅/更新/论坛/翻译地址、服务器字段）保留自原有部署契约。它们不包含私钥或节点凭据。`Tests/Fixtures/legacy-update-manifest.json` 是公开发布的 1.1.2 签名清单数据，仅用于验证更新格式兼容。

协议与平台资料：

- [Shadowsocks AEAD wire specification](https://shadowsocks.org/doc/aead.html)
- [VMess protocol documentation](https://www.v2fly.org/developer/protocols/vmess.html)
- [VMess AEAD documentation](https://www.v2fly.org/developer/protocols/vmess.html#vmess-aead)
- [RFC 6455 WebSocket](https://www.rfc-editor.org/rfc/rfc6455)
- [RFC 9293 TCP](https://www.rfc-editor.org/rfc/rfc9293)
- [PKWARE ZIP format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)
- [Apple Network framework](https://developer.apple.com/documentation/network)
- [Apple CryptoKit](https://developer.apple.com/documentation/cryptokit)
- [LevelDB file-format descriptions](https://github.com/google/leveldb/blob/main/doc/table_format.md)
- [Chromium local-storage format description](https://www.cclsolutionsgroup.com/post/chromium-session-storage-and-local-storage)

测试工具仅在开发时使用，不随应用分发：C/Swift 编译器、Node 内置测试/crypto、Python 标准库、Chromium，以及独立协议测试所用的系统加密接口。真实订阅和节点测试输入保存在工作区的私有临时文件中，不包含在本目录和发布产物中。

原仓库的 GPL 历史、上游贡献者的代码和第三方组件权利依然存在。本记录不替代权利转让合同、许可证意见或专利检索。发布方应根据保留的实际代码/素材与部署要求确定适用声明，不能通过删除旧声明取得上游权利。
