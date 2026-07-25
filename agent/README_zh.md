# NIE-SLA Agent 中文手册

NIE-SLA Agent 是 NIE-SLA 的 VPS 侧 Rust 采集器。它只主动向 Worker 发起 HTTPS 请求，不监听管理端口。

完整系统文档请从仓库根目录的 [中文主手册](../README.zh-CN.md) 开始。本文只讲 Agent。

## 工作方式

```text
每 1 秒采样系统指标
      |
      v
本地有界队列 ---- 上传失败时保留待重试样本
      |
约每 300 秒批量 POST /api/agent/metrics

每 20 秒 TCP Ping -> 批量 POST /api/agent/pings
周期读取 /api/agent/update-policy -> 按后台开关决定是否更新
```

上传间隔 300 秒不代表只有一个数据点；批次内包含本地连续采样。

## 支持平台

| 发布文件 | 平台 |
| --- | --- |
| `nstatus-metrics-linux-amd64` | x86_64 Linux |
| `nstatus-metrics-linux-386` | 32 位 x86 Linux |
| `nstatus-metrics-linux-arm64` | ARM64/aarch64 Linux |
| `nstatus-metrics-linux-arm` | ARMv7 hard-float |
| `nstatus-metrics-linux-armv6` | ARMv6 |
| `nstatus-metrics-windows-amd64.exe` | Windows x86_64 |

## 推荐安装

在管理后台先创建 TCP/VPS 目标，再点击“部署 Agent”，复制该节点专用命令。安装命令包含 scoped Token、Agent ID、API/下载地址、期望版本和 manifest 哈希。

不要使用 README 中的假 Token 安装，也不要把一台 VPS 的命令复制给另一台。

## Linux 安装结果

```text
/opt/nstatus-metrics/nstatus-metrics
/opt/nstatus-metrics/nstatus-metrics.env
/usr/local/bin/cftz
systemd 或 OpenRC 服务 nstatus-metrics
```

安装器会识别架构、校验 manifest、校验二进制、验证版本、停止旧进程，再安装服务。重复运行最新命令可安全更新并清理旧版残留。

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

当前 `cftz` 不包含 IP 解锁检测、解锁依赖安装或周期解锁脚本。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NSTATUS_API_BASE` | 必填 | HTTPS API Base |
| `NSTATUS_AGENT_TOKEN` | 必填 | 节点 scoped Token |
| `NSTATUS_AGENT_ID` | 主机名 | 必须与后台目标 ID 匹配 |
| `NSTATUS_AGENT_LABEL` | 主机名 | 展示名称 |
| `NSTATUS_SAMPLE_SEC` | `1` | 本地采样间隔 |
| `NSTATUS_INTERVAL_SEC` | `300` | 上传间隔 |
| `NSTATUS_PING_SEC` | `20` | Ping 间隔 |
| `NSTATUS_PING_TARGET_REFRESH_SEC` | `600` | 从后台刷新 Ping 目标配置的间隔（60–3600 秒） |
| `NSTATUS_PING_TARGETS` | `*` | 使用后台目标 |
| `NSTATUS_QUEUE_FILE` | 平台默认 | 队列文件 |
| `NSTATUS_QUEUE_MAX_SAMPLES` | 程序默认 | 队列上限 |
| `NSTATUS_UPDATE_CHECK_SEC` | 程序默认 | 更新策略检查间隔 |
| `NSTATUS_ALLOW_INSECURE_HTTP` | 关闭 | 仅可信私网调试 |

## 自动更新

后台开关动态控制，不是在安装时永久固定：

- 开启后，Agent 下次检查策略时可以自动更新。
- 关闭后，Agent 不主动修改自身。
- 手动 `cftz update` 不受后台自动更新开关限制。
- 更新前验证 `SHA256SUMS` 固定哈希、二进制哈希和版本。
- 校验失败时保留旧版本。

## 安全

- 公网 API 必须 HTTPS。
- 每台节点使用独立 scoped Token。
- env 文件限制权限，不在日志打印 Token。
- 完整安装命令视为秘密。
- `NSTATUS_ALLOW_INSECURE_HTTP=1` 只用于可信私网。

## IPv6-only VPS

Agent 上报是出站 HTTPS，只要 API/Pages 域名有 AAAA 或网络具备 NAT64 就能工作。CF TCP Latency 是另一条反向链路；若直接 IPv6 字面地址失败，为目标创建 DNS-only AAAA 域名。

## 日志排障

```bash
sudo cftz log 200
sudo journalctl -u nstatus-metrics -n 200 --no-pager
pgrep -af nstatus-metrics
```

常见问题：

- 401：Token 与 Agent ID 不匹配。
- HTTPS 错误：DNS、系统时间或证书链问题。
- 版本不更新：后台开关关闭、检查周期未到或校验失败。
- 多进程：重新运行最新安装命令并检查旧 cron/service。

详细步骤见 [Agent 安装、升级与卸载](../docs/zh-CN/04-agent.md) 和 [运维排障](../docs/zh-CN/09-operations.md)。

## 开发测试

```bash
cargo fmt -- --check
cargo check
cargo test
cargo build --release
```

## 本地构建完整 Release

发布完整 Agent 产物时，在 macOS/Linux 安装 Rust、Zig 和 `cargo-zigbuild`，然后运行：

```bash
./build-release.sh
```

脚本会一次生成 Linux amd64、arm64、armv7、armv6、386 和 Windows amd64 六个二进制，并在 `bin/` 生成同一批次的 `VERSION` 与 `SHA256SUMS`。全部目标成功前不会覆盖现有发布目录。可通过第一个参数指定其他输出目录；通过 `RUST_TOOLCHAIN` 固定 Rust 工具链版本。

## License

MIT
