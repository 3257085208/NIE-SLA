# Rust Agent

## 安装

在后台新增 VPS 后，点击“部署 Agent”并在目标机器执行该节点专属命令。安装器会识别架构、校验 manifest 与二进制哈希、验证版本并创建服务。

支持 Linux amd64、arm64、armv7、armv6、386 与 Windows amd64。

## Linux 服务

- `nstatus-metrics`：低权限遥测、Ping、GeoIP 与更新。
- `nstatus-metrics-tasks`：常驻 root Manager，负责固定动作、更新与服务维护。服务名为兼容旧安装而保留。

旧安装可能只有主服务。`v1.0.28` 起主 Agent 可在 Manager 缺失时通过自身私有状态目录低权限执行 IP 解锁，不要求 root，也不会尝试安装系统依赖或上传第三方报告；缺少可选 DNS 工具时提供一次性空结果入口，缺少 `jq` 时优先从当前 NIE-SLA Worker 下载随版本发布的 jq 官方固定产物并校验 SHA-256，GitHub 官方 Release 只作备用源。两者都只存在于任务私有目录，任务结束自动删除，不修改系统环境。已有 root 更新任务或以 root 运行的旧 Agent 会自动补齐 Manager。只有两种 root 通道都不存在的早期低权限安装需要执行一次修复，后台会单独标识。

```bash
systemctl status nstatus-metrics
systemctl status nstatus-metrics-tasks
journalctl -u nstatus-metrics -n 100 --no-pager
```

OpenRC 系统由安装器创建对应服务。

## 自动 GeoIP

主 Agent 启动后读取后台 GeoIP 配置，查询出口 IPv4/IPv6 并上报。位置失败不阻止指标上报。

## 固定 Beta 动作

Manager 每 60 秒轮询任务，只接受 `nodequality` 与 `ip_unlock`。主 Agent 的兼容回退请求只能领取 `ip_unlock`；Manager 心跳正常时主 Agent 不会重复轮询。下载地址、参数和 NQ 输入在二进制中固定，执行时不经过可拼接的 shell 命令，且清空 Agent 环境、限制下载大小、运行时间和输出。Worker 对动作与结果再次校验。

## 更新

新安装默认开启 Agent 自动更新，后台开关可随时关闭。Manager 定期检查更新，只接受高于当前版本的语义版本、Worker 给出的 manifest SHA-256 和 manifest 中匹配的二进制 SHA-256；下载后还会运行版本探测，再原子替换并保留上一版备份。更新后的 Manager 必须持续运行，低权限遥测服务也必须保持同一进程稳定一段时间，独立 watchdog 才会接受确认并删除备份；任一服务超时未确认都会自动回滚并重启。Manager 同时维护 systemd/OpenRC 服务定义，后续增删固定动作只需更新同一二进制。

旧版 systemd timer / OpenRC hourly job 只作为迁移桥梁；Manager 成功启动后会停用旧更新任务，避免重复轮询。没有任何 root 通道的节点无法在不破坏 Linux 权限边界的情况下静默创建 root 服务，需要按后台提示修复一次；节点 ID 与 Token 保持原值。

## 网络

Agent 只需要出站 HTTPS。不要开放额外管理端口。若 `workers.dev` 在 VPS 网络不可达，使用具有可用 A/AAAA 的自定义 Worker 域名。
