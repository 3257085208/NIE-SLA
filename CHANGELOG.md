# 更新日志

NIE-SLA 当前处于 Beta。应用使用 `0.x.y-beta.N`，Rust Agent 使用独立 `vX.Y.Z` 版本。

## 0.24.0-beta.2 - 2026-07-26

- 将兼容服务升级为常驻 root Manager，统一负责固定动作、验证更新、服务维护与能力心跳；以后增删动作不再新增 VPS 服务。
- Agent 主进程提供仅允许 `ip_unlock` 的低权限兼容模式；Manager 心跳正常时不会重复领取任务或增加请求量。
- Worker 保存经过白名单清洗的 Agent 能力，后台按每台 VPS 的真实能力启用按钮，并拒绝向离线或不支持的 Agent 排队。
- 固定脚本执行不再拼接 shell 命令，清空 Agent 环境并限制地址、参数、下载大小、运行时间和输出。
- Agent 更新增加独立稳定性 watchdog；新 Manager 或低权限遥测进程未在观察期内保持稳定时，自动恢复上一版并重启服务。
- 已有 Manager、root 更新任务或 root 主进程的旧安装会自动迁移；只有确实没有 root 通道的节点需要一次修复。
- Rust Agent 更新至 `v1.0.21`。

## 0.24.0-beta.1 - 2026-07-26

- 新部署改为单 Worker：Static Assets、API、D1、R2、Durable Objects 与每分钟 Cron 一次完成。
- 首次公开访问会自动初始化 D1 Schema，避免一键部署后等待 Cron 期间短暂返回 500。
- 保持旧 Agent API 协议、Target ID 和 scoped Token 兼容，支持从 Pages + Worker 复用原 D1/R2 迁移。
- 国家与城市不再手工选择，由 Agent 查询出口 IPv4/IPv6；后台可选 IP.SB、Cloudflare、IPIP.net 或自定义 HTTPS JSON。
- 商家目录、自定义商家和现有机器类型继续保留。
- 新增两个只能手动点击的 Beta 动作：NodeQuality 固定输入 `v/y/y/y`，IPv4 解锁只保存最终媒体解锁字段。
- Linux 新增独立 root 任务 runner；主遥测 Agent 继续低权限运行，接口不接受任意命令、参数、脚本 URL 或 stdin。
- 新安装默认开启已签名 Agent 自动更新；systemd timer 与 OpenRC hourly job 每小时检查，只允许语义版本升级并拒绝自动降级。
- 新增普通备份、密码保护敏感备份、恢复预览、合并/替换恢复与恢复前 R2 快照。
- 保留 Telegram、邮件、后台更新与内置外观配置。
- 移除主题、插件上传、市场导入和包运行时；公开 `/api/v1` 只读接口继续支持第三方前端。
- Rust Agent 更新至 `v1.0.20`，并由可信本地环境生成六架构 release 产物。

## 0.23.0-beta.2 - 2026-07-26

- 内测阶段曾提供手工国家/城市目录，现已由 0.24 的 Agent 自动 GeoIP 取代。

## 版本规则

- `app-v0.x.y-beta.N`：Worker 与同源前端 Beta 版本。
- `vX.Y.Z`：Rust Agent 二进制与 Release。
- 应用 `1.x.x` 留给正式稳定阶段。
