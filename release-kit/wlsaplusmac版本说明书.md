# WLSAPlus macOS 版本说明书（1.0.9）

## 下载方法
1. 从 GitHub 上下载源文件（Release 里的 `wlsaplusformac.zip`）或从官网上下载。
2. 解压后执行 `构建wlsaplus.command`，双击即可。若提示不安全：点完成 → 系统设置 → 隐私与安全 → 拉到最下面点「仍要打开」。中间可能要输入密码，屏幕上可能什么也不显示，输入后回车即可。
3. 构建脚本会**全程使用国内镜像**（无需科学上网），包括：
   - nvm：`https://gitee.com/RubyMetric/nvm-cn`
   - Node：`https://npmmirror.com/mirrors/node`
   - npm：`https://registry.npmmirror.com`
   - Electron：`https://npmmirror.com/mirrors/electron/`
4. 在弹出的文件夹里选择一个 `.dmg` / `.zip`，双击安装即可。

> 发布包内通常已包含一份 `git clone` 下来的 `wlsaplus-enablemacos` 工程目录；请保持与 `构建wlsaplus.command` 同级，或放在 `~/Downloads/wlsaplusformac/wlsaplus-enablemacos/`。

## 使用 VPN
1. 打开 Tools → VPN。
2. 可先「Refresh」节点列表，需要时点「Test latency」测延迟，再选中节点。
3. 点 Connect。若弹出管理员授权，输入密码并允许。授权前若短暂提示等待，属正常，不要反复乱点。
4. 可用「Test WeChat」检测连 VPN / 不连 VPN 时微信相关地址是否可达（仅网络探测，不等于微信能否登录）。

## 关闭 VPN（请按顺序）
1. 回到 VPN 页，若有 Disconnect，先点 Disconnect。
2. 打开「活动监视器」→「网络」，找到 `clash`（或 mihomo 相关进程），选中后点左上角停止（叉），确认退出。
3. 确认 VPN 页状态回到 Ready / Connect。

## 开课提醒
设置里可开关「Class reminders」。开启后，开课前约 5 分钟会发 macOS 通知（需已同步课表）。

## 课表与成绩
Connect / 同步 PowerSchool 后，可在课表与 Progress（成绩、作业、考勤）中查看。数据保存在本地。
