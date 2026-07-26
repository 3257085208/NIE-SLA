# Rust Agent

## 安装

在后台新增 VPS 后，点击“部署 Agent”并在目标机器执行该节点专属命令。安装器会识别架构、校验 manifest 与二进制哈希、验证版本并创建服务。

支持 Linux amd64、arm64、armv7、armv6、386 与 Windows amd64。

## Linux 服务

- `nstatus-metrics`：低权限遥测、Ping、GeoIP 与更新。
- `nstatus-metrics-tasks`：root 固定动作 runner，仅用于两个 Beta 动作。

旧安装只会有主服务。要启用 Beta 动作，重新执行一次最新部署命令。

```bash
systemctl status nstatus-metrics
systemctl status nstatus-metrics-tasks
journalctl -u nstatus-metrics -n 100 --no-pager
```

OpenRC 系统由安装器创建对应服务。

## 自动 GeoIP

主 Agent 启动后读取后台 GeoIP 配置，查询出口 IPv4/IPv6 并上报。位置失败不阻止指标上报。

## 固定 Beta 动作

runner 每 60 秒轮询任务，只接受 `nodequality` 与 `ip_unlock`。脚本 URL、参数和 NQ 输入在二进制中固定。Worker 对 NQ 报告域名和 IP 解锁结构再次校验。

## 更新

新安装默认开启 Agent 自动更新，后台开关可随时关闭。systemd 使用 timer，OpenRC 使用 hourly job，每小时检查一次；只接受高于当前版本的语义版本、固定 manifest 哈希和匹配的二进制 SHA-256。线上版本相同或更旧时不会覆盖当前 Agent，失败时继续运行旧版本。

旧安装需要重新粘贴一次最新部署命令，以安装低权限主服务、root updater，以及 systemd timer 或 OpenRC hourly job。命令会先停止旧服务和残留进程，再安装当前版本；节点 ID 与 Token 保持原值。

## 网络

Agent 只需要出站 HTTPS。不要开放额外管理端口。若 `workers.dev` 在 VPS 网络不可达，使用具有可用 A/AAAA 的自定义 Worker 域名。
