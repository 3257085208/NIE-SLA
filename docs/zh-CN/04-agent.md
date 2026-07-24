# 04 Agent 安装、升级与卸载

Agent 是 Rust 编写的单文件程序，负责本地采样、排队、上报和 TCP Ping。推荐始终使用后台为目标生成的安装命令。

## 安装前检查

Linux：

```bash
uname -m
cat /etc/os-release
command -v curl
command -v sudo
```

确保 VPS 可以访问 Pages 下载域名和 Worker API。IPv6-only VPS 的 Pages/API 域名必须有可用 AAAA，或者系统具备 NAT64。

## 推荐安装方式

1. 后台创建 TCP/VPS 目标。
2. 点击“部署 Agent”。
3. 复制 Linux 或 Windows 命令。
4. 在对应机器执行。
5. 返回后台查看 Agent 版本与最后上报时间。

不要把 A 节点的命令用于 B 节点。命令内 scoped Token 与 target ID 绑定，错误复用会导致身份不匹配。

## Linux 安装过程

安装器会：

1. 检测 `uname -m` 与 ABI。
2. 下载 `VERSION`、`SHA256SUMS` 和目标二进制。
3. 校验 manifest 固定哈希。
4. 校验二进制哈希。
5. 执行 `--version` 验证期望版本。
6. 停止同名 systemd/OpenRC/旧后台进程。
7. 创建低权限 `nstatus` 用户。
8. 写入 `/opt/nstatus-metrics/`。
9. 将环境变量写入仅 root/服务用户可读的 env 文件。
10. 安装并启动服务。
11. 安装 `cftz` 管理工具。

安装是可重复执行的。重新运行最新命令会保留节点身份并替换旧二进制，也会停止旧版可能残留的进程。

## 文件位置

典型 Linux：

```text
/opt/nstatus-metrics/nstatus-metrics
/opt/nstatus-metrics/nstatus-metrics.env
/usr/local/bin/cftz
/etc/systemd/system/nstatus-metrics.service
```

OpenRC 使用 `/etc/init.d/nstatus-metrics`。没有 init 系统时安装器会后台启动，但这种模式的自动重启能力较弱。

## 常用命令

```bash
sudo cftz status
sudo cftz log 100
sudo cftz update
sudo cftz set
sudo cftz admin
sudo cftz totp-setup
sudo cftz uninstall
```

systemd：

```bash
sudo systemctl restart nstatus-metrics
sudo systemctl status nstatus-metrics --no-pager
sudo journalctl -u nstatus-metrics -f
```

OpenRC：

```bash
sudo rc-service nstatus-metrics restart
sudo tail -f /var/log/nstatus-metrics.log
```

## 配置变量

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `NSTATUS_API_BASE` | Worker/Pages API Base | 必填 |
| `NSTATUS_AGENT_TOKEN` | 节点 scoped Token | 必填 |
| `NSTATUS_AGENT_ID` | 与后台目标 ID 相同 | 主机名回退 |
| `NSTATUS_AGENT_LABEL` | 展示名称 | 主机名 |
| `NSTATUS_SAMPLE_SEC` | 本地采样间隔 | `1` |
| `NSTATUS_INTERVAL_SEC` | 上报批次间隔 | `300` |
| `NSTATUS_PING_SEC` | TCP Ping 间隔 | `20` |
| `NSTATUS_PING_TARGET_REFRESH_SEC` | 从后台刷新 Ping 目标配置的间隔 | `600` |
| `NSTATUS_PING_TARGETS` | `*` 表示使用后台目标 | `*` |
| `NSTATUS_QUEUE_FILE` | 持久队列文件 | 平台默认路径 |
| `NSTATUS_QUEUE_MAX_SAMPLES` | 最大排队样本 | 程序默认 |
| `NSTATUS_UPDATE_CHECK_SEC` | 更新策略检查间隔 | 程序默认 |
| `NSTATUS_ALLOW_INSECURE_HTTP` | 明确允许可信私网 HTTP | 未启用 |

Token 不应直接写在命令行参数中长期运行，因为其他本地用户可能从进程列表读取。安装器使用受权限保护的环境文件。

## 采样和上传调度

Agent 内部将采样、Ping、上传和更新检查拆开调度：

- 采样线程按秒运行。
- 上传线程按批次读取队列。
- 网络慢不会阻塞下一次采样。
- 上传失败不会无限占用内存；队列有上限。
- 新样本与待重试样本统一打包。

所以看到 Worker 每几分钟收到一个 POST 是正常的，不代表指标只有一个点。

## 自动更新

Agent 使用自身 scoped Token 查询策略。满足以下条件才自动更新：

1. Worker 开关为开启。
2. 返回版本高于当前版本。
3. 平台支持自动安装。
4. manifest 哈希验证成功。
5. 二进制哈希和版本验证成功。

任何校验失败都会保留旧二进制。更新成功后服务重启并用原配置继续上报。

手动更新：

```bash
sudo cftz update
```

或者重新运行后台最新安装命令。

## Windows

后台 Windows 命令会下载 `install.ps1`，校验 Windows amd64 二进制并创建计划任务。常见检查：

```powershell
Get-ScheduledTask | Where-Object TaskName -Match 'NIE-SLA'
Get-Process | Where-Object ProcessName -Match 'nstatus'
```

Windows 当前建议手动执行新安装命令更新。

## HTTPS 要求

Agent 默认拒绝公网 HTTP API：

```text
Agent API base must use HTTPS
```

只有 localhost 可直接使用 HTTP。可信私网测试可以显式设置：

```bash
export NSTATUS_ALLOW_INSECURE_HTTP=1
```

不要在公网部署中使用该开关，否则 Token 和指标可能被窃听。

## 卸载

```bash
sudo cftz uninstall
```

卸载会停止服务并删除 Agent 程序/服务配置。后台目标和历史仍保留；如不再监控，请在后台禁用或删除目标。

## 故障排查

### 服务运行但后台无数据

```bash
sudo cftz log 200
curl -fsSL https://YOUR-API/api/health
```

检查 ID、Token、系统时间、DNS、HTTPS 证书和 API Base。

### `401`

节点 ID 与 scoped Token 不匹配，或使用了过期/错误命令。重新从该目标复制安装命令。

### 版本仍旧

- 查看后台自动更新是否开启。
- 等待一个更新检查周期。
- 运行 `sudo cftz update`。
- 检查下载域名的 `VERSION` 和 `SHA256SUMS`。
- 查看日志中的 manifest/version mismatch。

### CPU 周期性升高

当前版本不包含 IP 解锁检测。先确认系统只运行一个 Agent：

```bash
pgrep -af nstatus-metrics
systemctl list-timers --all
crontab -l
sudo ls -la /etc/cron.*
```

旧版残留可通过重新运行最新安装命令清理；同时检查其他定时任务，不要仅凭 CPU 波峰判断 Agent。

## 版本与发布文件

下载目录中的 `VERSION`、`SHA256SUMS` 和所有二进制必须来自同一次发布。只替换 `VERSION` 而不替换二进制会让安装器正确拒绝安装。
