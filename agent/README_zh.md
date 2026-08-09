# NIE-SLA Agent 中文手册

NIE-SLA Agent 是 VPS 侧的 Rust 采集器，只主动向 Worker 发起 HTTPS 请求，不监听任何管理端口。系统完整文档从仓库根的 [中文主手册](../README.zh-CN.md) 开始，本文只讲 Agent。

## 工作方式

```text
每 1 秒采样系统指标
      |
      v
本地有界队列 —— 上传失败时保留待重试样本
      |
约每 300 秒批量 POST /api/agent/metrics

每 20 秒 TCP Ping -> 批量 POST /api/agent/pings
周期读取 /api/agent/update-policy -> 按后台开关决定是否更新
```

300 秒是上传间隔，不是采样间隔；一个批次里包含本地的连续采样点。队列文件在重启后仍可恢复。

## 发布文件

| 文件 | 平台 |
| --- | --- |
| `nstatus-metrics-linux-amd64` | x86_64 Linux |
| `nstatus-metrics-linux-386` | 32 位 x86 Linux |
| `nstatus-metrics-linux-arm64` | ARM64/aarch64 Linux |
| `nstatus-metrics-linux-arm` | ARMv7 hard-float |
| `nstatus-metrics-linux-armv6` | ARMv6 |

## 安装

在管理后台先创建 TCP/VPS 目标，再点击“部署 Agent”，复制该节点专用命令。命令包含 scoped Token、Agent ID、API/下载地址、期望版本与 manifest 哈希，属于敏感凭据：不要公开，不要把一台 VPS 的命令复制给另一台，不要用文档里的假 Token 安装。

安装结果：

```text
/opt/nstatus-metrics/nstatus-metrics
/opt/nstatus-metrics/nstatus-metrics.env
/usr/local/bin/cftz
systemd 或 OpenRC 服务 nstatus-metrics
```

安装器识别架构、校验 manifest 与二进制、验证版本、停止旧进程，再安装服务。重复运行最新命令可以安全更新并清理旧版残留。

## 常用命令

```bash
sudo cftz status       # 服务状态
sudo cftz log 100      # 最近 100 行日志
sudo cftz update       # 手动更新
sudo cftz set          # 修改 API/ID/Ping 等配置
sudo cftz admin        # 终端管理目标
sudo cftz totp-setup   # 设置 TOTP
sudo cftz uninstall    # 卸载 Agent
```

`cftz` 不包含 IP 解锁检测、解锁依赖安装或周期解锁脚本。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NSTATUS_API_BASE` | 必填 | Worker 的 HTTPS API Base |
| `NSTATUS_AGENT_TOKEN` | 必填 | 节点 scoped Token |
| `NSTATUS_AGENT_ID` | 主机名 | 必须与后台目标 ID 一致 |
| `NSTATUS_AGENT_LABEL` | 主机名 | 展示名称 |
| `NSTATUS_SAMPLE_SEC` | `1` | 本地采样间隔 |
| `NSTATUS_INTERVAL_SEC` | `300` | 指标上传间隔 |
| `NSTATUS_PING_SEC` | `20` | Ping 间隔 |
| `NSTATUS_PING_TARGET_REFRESH_SEC` | `600` | 后台 Ping 目标刷新间隔（60–3600 秒） |
| `NSTATUS_PING_TARGETS` | `*` | 使用的后台目标 |
| `NSTATUS_QUEUE_FILE` | 平台默认 | 队列文件路径 |
| `NSTATUS_QUEUE_MAX_SAMPLES` | `86400` | 队列上限 |
| `NSTATUS_UPDATE_CHECK_SEC` | `3600` | 更新策略检查间隔（900–86400 秒） |
| `NSTATUS_ALLOW_INSECURE_HTTP` | 关闭 | 仅限可信私网调试，公网必须 HTTPS |

单批上报最多 300 个采样点、5000 条 Ping；Ping 队列容量 200–10000，并发上限 32，单次 TCP 探测超时 1 秒，最多解析 8 个地址。

## 自动更新

后台开关动态控制，不是在安装时永久固定：

- 开启时，Agent 下次检查策略可以自动更新。
- 关闭时，Agent 不主动修改自身。
- 手动 `cftz update` 不受开关限制。
- 更新前验证 `SHA256SUMS` 固定哈希、二进制哈希与版本；校验失败保留旧版本。
- 更新后旧进程通过 `exec` 重启，服务连续。

## 固定 Beta 动作

Agent 轮询 `/api/agent/tasks` 领取任务。只支持两个编译进二进制的动作：NodeQuality 与 IPv4 解锁检测。两者由 root Manager 执行（需要 raw socket、路由探测与系统工具），遥测服务保持低权限。

- NodeQuality 运行后台选择的四项测试，默认 `f/y/y/y`；当前版本不设置外部超时。
- IPv4 解锁固定运行 `IP.Check.Place -4 -n -p`，超时上限 600 秒，完整报告最多 64 KiB。
- 任务脚本由 Worker 提供并校验 SHA-256，运行环境经过清理，超时后对整个进程组发信号终止。

## 安全

- 公网 API 必须 HTTPS。
- 每台节点使用独立 scoped Token；安装票据一次性有效。
- env 文件限制权限，Token 不出现在日志。
- Agent 没有入站端口；root 能力只属于 Manager 的两个固定动作。
