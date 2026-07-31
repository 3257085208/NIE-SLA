# Rust Agent

## 安装

在后台新增 VPS 后，点击“部署 Agent”并在目标机器执行该节点专属命令。生成命令先校验 `install.sh`，`install.sh` 校验 `setup.sh`，`setup.sh` 再校验 `cftz`、manifest、目标架构二进制和版本，然后创建服务。这条同源哈希链用于发现传输损坏与产物错配，不是独立离线签名。

支持 Linux amd64、arm64、armv7、armv6 与 386。

## Linux 服务

- `nstatus-metrics`：低权限遥测、Ping、GeoIP 与更新。
- `nstatus-metrics-tasks`：常驻 root Manager，负责固定动作、更新与服务维护。服务名为兼容旧安装而保留。

旧安装可能只有主服务。`v1.0.49` 起固定动作只由 root Manager 领取，但脚本执行前会降到独立的 `nstatus-task` 宿主账户，再进入 user/mount/pid/ipc/uts namespace；隔离能力缺失时任务失败，不会回退为宿主 root 或低权限遥测进程直接执行。系统缺少 `dig` 或 `nslookup` 时由 Agent 内置受限解析器提供任务内兼容查询；缺少 `jq` 时优先从当前 NIE-SLA Worker 下载随版本发布的 jq 官方固定产物并校验 SHA-256，GitHub 官方 Release 只作备用源。兼容文件只存在于任务私有目录，任务结束自动删除，不修改系统环境。已有 root 更新任务或以 root 运行的旧 Agent 会自动补齐 Manager。没有任何 root 通道的早期低权限安装需要执行一次修复，后台会单独标识。

```bash
systemctl status nstatus-metrics
systemctl status nstatus-metrics-tasks
journalctl -u nstatus-metrics -n 100 --no-pager
```

OpenRC 系统由安装器创建对应服务。

磁盘容量与使用率表示 Unix 根文件系统或 Windows 系统卷。绑定挂载和其他数据盘不会相加，避免同一个底层文件系统被重复计数。

## 自动 GeoIP

主 Agent 启动后读取后台 GeoIP 配置，查询出口 IPv4/IPv6 并上报。位置失败不阻止指标上报。

## 固定 Beta 动作

Manager 每 5 分钟轮询任务，只接受 `nodequality` 与 `ip_unlock`。两个入口脚本由当前站点的 `/vendor/tasks/` 提供已审计快照，Agent 在执行前比较二进制内固定的 SHA-256。下载地址、参数和 NQ 输入均在二进制中固定，不经过可拼接的 shell 命令；运行时清空 Agent 环境并限制下载大小、运行时间和输出。Worker 对动作与结果再次校验。

NodeQuality 保存结构化报告及经过白名单校验的原报告链接，不抓取报告网站。Worker 只把其中的网络质量和回程路由文本本地渲染为 SVG，并通过固定 S3 渠道、空目录上传；公开端只返回同源图片代理，图床地址与 Token 不会发给 Agent 或浏览器。

IPv4 解锁报告中的国家/地区字段按上游原值保存；颜色根据报告的原生、DNS 或失败类型显示。Agent 升级不会自动覆盖旧报告，如旧结果曾因缺少 DNS 工具被误判，需要在后台重新运行一次 IPv4 解锁。

## 更新

新安装默认开启 Agent 自动更新，后台开关可随时关闭。Manager 定期检查更新，只接受高于当前版本的语义版本、Worker 给出的 manifest SHA-256 和 manifest 中匹配的二进制 SHA-256；下载后还会运行版本探测，再原子替换并保留上一版备份。更新后的 Manager 必须持续运行，低权限遥测服务也必须保持同一进程稳定一段时间，独立 watchdog 才会接受确认并删除备份；任一服务超时未确认都会自动回滚并重启。Manager 同时维护 systemd/OpenRC 服务定义，后续增删固定动作只需更新同一二进制。

systemd timer / OpenRC hourly job 作为 root 恢复通道保留，但会先检查 `nstatus-metrics-tasks`：Manager 正常时立即退出，不重复轮询；Manager 停止时才执行经过校验的 `cftz update --automatic`，用于修复损坏或缺失的 Manager。没有任何 root 通道的节点无法在不破坏 Linux 权限边界的情况下静默创建 root 服务，需要按后台提示修复一次；节点 ID 与 Token 保持原值。

## 网络

Agent 只需要出站 HTTPS。不要开放额外管理端口。若 `workers.dev` 在 VPS 网络不可达，把具有可用 A/AAAA 且已路由到 Worker 的自定义域名填入后台“设置 → Agent → Agent 连接域名”；随后生成的安装命令和更新策略会统一使用该地址。
