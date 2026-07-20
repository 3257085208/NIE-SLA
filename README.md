<div align="center">

# NIE-SLA

**基于 Cloudflare 的开源状态页、VPS 遥测与告警系统**

Worker + D1 + R2 + Pages + Durable Objects + Rust Agent

[![Agent Version](docs/badges/agent-version.svg)](https://github.com/3257085208/NIE-SLA/releases)
[![Worker Compatible](docs/badges/worker.svg)](https://developers.cloudflare.com/workers/)
[![Top Language](docs/badges/language.svg)](https://github.com/3257085208/NIE-SLA)
[![License](docs/badges/license.svg)](LICENSE)

[![Contributors](docs/badges/contributors.svg)](https://github.com/3257085208/NIE-SLA/graphs/contributors)
[![Commit Activity](docs/badges/commits.svg)](https://github.com/3257085208/NIE-SLA/commits/main)
[![Repo Size](docs/badges/size.svg)](https://github.com/3257085208/NIE-SLA)
[![Agent CI](https://github.com/3257085208/NIE-SLA/actions/workflows/agent-ci.yml/badge.svg)](https://github.com/3257085208/NIE-SLA/actions/workflows/agent-ci.yml)

[完整中文文档](#文档导航) · [English](README.en.md) · [Release](https://github.com/3257085208/NIE-SLA/releases) · [安全策略](SECURITY.md)

</div>

## 项目定位

NIE-SLA 把公开状态页、Cloudflare 边缘探测和 VPS 系统遥测放在同一套系统中。它适合个人、自托管服务和小型基础设施，不要求额外购买中心服务器：控制面运行在 Cloudflare，VPS 只运行一个出站 HTTPS Agent，不需要开放 Agent 入站端口。

它解决以下问题：

- 从 Cloudflare 边缘定时检查 HTTP 与 TCP 服务。
- 用 Rust Agent 每 1 秒采集 CPU、内存、磁盘、负载、网络、磁盘 IO、连接数等原始指标。
- 将 1 秒原始样本按批次上传，网络慢或短暂断网时进入本地持久队列，而不是降低采样精度。
- 从各 VPS 执行 TCP Ping，并在前端查看 Latency 历史。
- 管理流量额度、到期日、价格、币种、标签和位置。
- 使用 Telegram 发送离线、恢复、资源、流量和到期告警。
- 使用 Admin Token 与可选 TOTP 管理目标、排序、主题、Agent 更新策略和告警。

## 功能一览

| 模块 | 能力 | 默认精度/周期 |
| --- | --- | --- |
| Cloudflare 探测 | HTTP、TCP、状态码、Latency、区域探测 | 5 分钟桶；每分钟 Cron 提供补跑窗口 |
| Agent Metrics | CPU、内存、磁盘、Load、网络、IO、进程、线程、连接数 | 本地 1 秒采样，默认 5 分钟批量上报 |
| Agent Ping | 后台集中管理 TCP Ping 目标 | 默认 20 秒 |
| Agent 配置刷新 | 获取 Ping 目标和更新策略 | Ping 目标默认 10 分钟，更新默认 1 小时 |
| 历史存储 | R2 小时级遥测对象、状态快照；D1 最新状态与业务元数据 | 原始 Metrics 不写入 D1 |
| 状态页 | 服务卡片、30/90 天可用率、故障记录、图表、移动端 | 公共缓存默认 45 秒 |
| 管理后台 | Target CRUD、拖动排序、主题、TOTP、告警、Agent 安装命令 | Token + 可选 TOTP |
| Agent 更新 | 后台开关控制自动更新，manifest 与二进制双 SHA-256 校验 | 默认关闭 |

## 架构与数据流

```text
                         public HTTPS
Browser ------------------------------------------------------+
  |                                                           |
  v                                                           v
Cloudflare Pages                                        Cloudflare Worker
status page + admin UI                                  API + Cron + alerts
  |                                                           |
  | /api/* direct route or Pages Function proxy               |
  +----------------------------->------------------------------+
                                                              |
                         +----------------+--------------------+----------------+
                         |                |                                     |
                         v                v                                     v
                    D1 Database       R2 Bucket                         Durable Objects
                    config/state      raw history                      optional regions
                    incidents         snapshots
                         ^                ^
                         |                |
                         +-------- Worker ingest <-------- Rust Agent on VPS
                                                          1s sample + queue
                                                          20s TCP Ping
```

### 为什么 1 秒采样不会产生 1 秒一次 Worker 请求

Agent 将采样和上传分开调度。采样线程每秒写入本地队列，上传线程默认每 300 秒将这段时间的全部原始点一次打包。Worker 把同一小时的 Metrics 与 Ping 合并到一个 R2 `telemetry.json` 对象中。因此请求数和 R2 PUT 数较低，但历史接口仍能返回原始 1 秒点。

### 为什么 Cron 每分钟触发，但探测仍是 5 分钟

Cloudflare Scheduled Trigger 偶尔会延迟。Worker 每分钟只查询一次“是否存在到期目标”，没有目标到期就立即结束，不读取遥测历史，也不执行告警或状态快照。目标仍按自身 `interval_sec` 执行，默认是 300 秒；额外的四次触发只是补跑机会。真正探测前还有 D1 原子租约，避免延迟任务与下一分钟任务重复运行。

### 数据放在哪里

| 存储 | 保存内容 | 设计原因 |
| --- | --- | --- |
| D1 | Targets、最新状态、日桶、告警状态、TOTP Session 哈希、流量累计 | 适合查询、约束与事务状态 |
| R2 | Agent 原始 Metrics/Ping、状态快照、历史归档 | 避免高频数据消耗大量 D1 行读取与写入 |
| Cache API | 公共状态和历史响应 | 减少重复计算与 D1/R2 请求 |
| Agent 本地文件 | 尚未确认上传的采样队列 | Worker 或网络故障后可重试 |

## 版本兼容

| 组件 | 当前公开版本 | 兼容说明 |
| --- | --- | --- |
| Rust Agent | `v1.0.17` | 当前最新版本；Linux amd64/arm64/armv7/armv6/armv5/386 与 Windows amd64 |
| Worker API | `main` | 与 Agent `v1.0.10` 至 `v1.0.17` 协议兼容；推荐两端同时更新 |
| Frontend | `main` | 与本仓库同一 commit 的 Worker 配套使用 |
| Cloudflare Runtime | `compatibility_date = 2026-06-17` | 需要 Workers、D1、R2；区域探测额外使用 Durable Objects |
| Node.js | `18+` | 部署和测试使用，CI 使用 Node.js 24 |
| Rust | `1.86.0` | Release CI 固定工具链 |

旧 Agent 可能仍能上传基本字段，但缺少持久队列、scoped Token、自动更新或新 Ping 调度等能力，不作为公开版本的长期兼容承诺。

## 快速部署

### 前置条件

- 一个 Cloudflare 账号。
- Node.js 18 或更高版本。
- Git 与 Bash；Windows 推荐 Git for Windows。
- Wrangler 登录权限：`npx wrangler login`。
- 一个 Pages 域名和一个 Worker URL。自定义域名不是必需，但生产建议使用。

### 一键流程

```bash
git clone https://github.com/3257085208/NIE-SLA.git
cd NIE-SLA/worker
bash deploy.sh
```

部署脚本会执行：

1. 检查 Node.js、Wrangler 和当前 Cloudflare 账号。
2. 创建或复用 D1 `nstatus-db` 与 R2 `nstatus-archive`。
3. 从本仓库 Release 下载当前 Agent 的 7 个架构产物、`VERSION` 和 `SHA256SUMS`。
4. 验证每个二进制的 SHA-256，并计算 manifest 固定哈希。
5. 交互写入 `ADMIN_TOKEN`、`AGENT_TOKEN` 和 `TOTP_ENCRYPTION_KEY`。
6. 生成只属于你账号且被 Git 忽略的 `worker/wrangler.local.toml`。
7. 部署 Worker、Cron、Durable Object 与 Pages。
8. 把 Agent 下载文件随 Pages 发布，供后台生成固定版本安装命令。

完整新手教程（概念、前置、一键/手动、域名、Agent、验收、排障）见 [Cloudflare 从零部署（新手完整教程）](docs/zh-CN/02-deployment.md)。

## 必须配置的 Secret

使用交互式命令输入，避免将值写进 Shell 历史：

```bash
cd worker
npx wrangler secret put ADMIN_TOKEN --config wrangler.local.toml
npx wrangler secret put AGENT_TOKEN --config wrangler.local.toml
npx wrangler secret put TOTP_ENCRYPTION_KEY --config wrangler.local.toml
```

推荐使用至少 32 字节随机值：

```bash
openssl rand -hex 32
```

| Secret | 用途 | 能否发给 Agent |
| --- | --- | --- |
| `ADMIN_TOKEN` | 管理后台最高权限 | 不能 |
| `AGENT_TOKEN` | 服务端派生每节点 scoped Token | 主 Token 不能；只使用后台生成的 scoped Token |
| `TOTP_ENCRYPTION_KEY` | AES-GCM 加密 TOTP Secret | 不能 |
| `ALERT_ENCRYPTION_KEY` | 可选，加密 Telegram 凭据 | 不能 |

## 安装 Agent

推荐流程：

1. 登录 `admin.html`。
2. 创建与 VPS 对应的 Target。
3. 点击该 Target 的 Agent 部署功能。
4. 复制后台生成的 Linux 或 Windows 命令。
5. 只在该 Target 对应的机器执行。

后台命令会携带节点 ID、节点专用 scoped Token、API Base、Pages 下载 Base、manifest 哈希和期望版本。不要把 A 节点的命令复制到 B 节点，也不要在 Issue、聊天记录或截图中公开完整命令。

Linux 管理：

```bash
sudo cftz status
sudo cftz log 100
sudo cftz update
sudo cftz uninstall
```

详细安装过程、文件位置、systemd/OpenRC、Windows、更新策略和故障排查见 [Agent 安装与维护](docs/zh-CN/04-agent.md)。

## 自动更新语义

- 后台开关开启：Agent 检测到更高版本后，验证 manifest、二进制 SHA-256 和程序自报版本，全部通过才替换并重启。
- 后台开关关闭：Agent 仍可获知新版本，但不会主动安装，管理员可执行 `sudo cftz update` 或重新运行后台命令。
- 安装时的开关状态不会永久写死。Agent 每次检查都以 Worker 当前返回策略为准。
- 自动更新默认关闭，公共部署应先在一台测试 VPS 验证再开启。

## IPv6 与 Cloudflare TCP 探测

IPv6 literal 与端口组合必须写成 `[2001:db8::10]:443`，但后台已经把 Host 与 Port 分开，因此 Host 字段只填写 `2001:db8::10`，Port 单独填写。

更推荐使用 DNS-only AAAA 域名：

```text
probe.example.com  AAAA  2001:db8::10
Cloudflare Proxy: DNS only
```

不要给任意 TCP 探测域名开启橙云。Workers TCP Socket 不能连接 Cloudflare 自身代理地址。完整原理和错误对照见 [IPv6、AAAA 与 CF TCP 探测](docs/zh-CN/12-ipv6-cloudflare-probe.md)。

## 安全模型

- Admin/Agent Token 使用常量时间比较。
- 每台 Agent 使用由服务端派生、与 Target ID 绑定的 scoped Token。
- TOTP Secret 使用 AES-GCM 加密；Session 在 D1 中只保存哈希。
- 安装器验证 manifest 固定哈希、二进制哈希和二进制版本。
- Agent 默认拒绝公网明文 HTTP API。
- 公共状态响应会隐藏查询参数、凭据、Cloudflare Colo，并可掩码 IP/端口。
- D1 登录限流和 Agent 历史写锁用于降低并发穿透与覆盖风险。
- CI 包含 Secret 安全检查，防止 Token、私钥和本地配置被意外提交。

安全边界、威胁模型、部署前审计清单见 [安全与免费额度](docs/zh-CN/10-security-free-tier.md) 和 [SECURITY.md](SECURITY.md)。

## Cloudflare 免费额度设计

- Agent 1 秒采样在 VPS 本地聚合上传，不产生每秒 Worker 请求。
- Metrics 与 Ping 合并为每 Agent、每小时一个 R2 telemetry 对象，每次报告最多一次 R2 PUT。
- 日可用率优先复用 R2 状态中的 90 天摘要，D1 常规只查询最近两天和必要回退。
- 公共状态使用 Cache API 与 R2 快照。
- 原始高频 Metrics/Ping 默认不写 D1。
- `/api/*` 可直接绑定 Worker Route，避免请求先进入 Pages Function 再转发。

以下估算使用 2026-07 Cloudflare Free 公开额度，并假设每台 VPS 保持 1 秒指标采样、5 个 20 秒 Ping 目标、72 小时 R2 原始历史，且 `AGENT_METRICS_TO_D1=false`、`AGENT_PINGS_TO_D1=false`。每个 Agent 每 10 分钟刷新 Ping 配置、每小时检查更新策略；Worker Cron 每分钟触发一次，并预留约 4,560 次/天给公开状态页、后台和其他 API 请求。

| 资源 | Cloudflare Free 额度 |
| --- | ---: |
| Workers 外部请求 | 100,000 次/天 |
| Workers Free CPU | 每次请求通常 10 ms CPU |
| D1 行读取 | 5,000,000 行/天 |
| D1 行写入 | 100,000 行/天 |
| D1 存储 | 5 GB/账号，单个 Free 数据库上限 500 MB |
| R2 Class A | 1,000,000 次/月 |
| R2 Class B | 10,000,000 次/月 |
| R2 Standard 存储 | 10 GB-month/月 |
| R2 公网出口流量 | 免费 |

官方参考：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)、[R2 Pricing](https://developers.cloudflare.com/r2/pricing/)。D1 按实际读取/写入的行计数，索引也可能增加写入行数，最终应以 Cloudflare Dashboard 的 `rows_read`、`rows_written` 为准。

### 5 分钟上传：50 台 VPS

```text
指标上传       50 × 288 = 14,400 次/天
Ping 配置刷新  50 × 144 =  7,200 次/天
更新策略检查   50 ×  24 =  1,200 次/天
Cron                       1,440 次/天
状态页/后台预留             4,560 次/天
合计                       28,800 次/天
```

| Cloudflare 资源 | 50 台具体用量 | 免费额度 | 占用比例 | 说明 |
| --- | ---: | ---: | ---: | --- |
| Workers 请求 | 约 28,800 次/天 | 100,000 次/天 | 28.8% | 包含 Agent、Cron 和访问预留 |
| D1 行读取 | 约 150,000-300,000 行/天 | 5,000,000 行/天 | 3%-6% | Agent 鉴权、限流、状态、流量和 Cron 目标读取 |
| D1 行写入 | 约 30,000-45,000 行/天 | 100,000 行/天 | 30%-45% | 原始 Metrics/Ping 不写 D1，锁和索引仍增加写入 |
| D1 存储 | 通常低于 50 MB | 5 GB/账号 | 低于 1% | 同时受单数据库 500 MB 上限约束 |
| R2 Class A 写入 | 约 432,000 次/月 | 1,000,000 次/月 | 43.2% | 14,400 次/天 × 30 天 |
| R2 Class B 读取 | 约 432,000 次/月，另加图表读取 | 10,000,000 次/月 | 约 4.32% 起 | 写入前读取现有小时对象 |
| R2 存储 | 约 2.2-2.4 GB-month | 10 GB-month/月 | 22%-24% | 72 小时 1 秒指标和每台 5 个 Ping |
| Agent Ping 点 | 1,080,000 点/天 | 批量随指标上传 | 0% 额外请求 | `50 × 5 × 86400 / 20` |
| Durable Object | 最多约 14,400 次区域探测调用/天 | 取决于区域目标 | - | 仅非 `auto` 区域目标使用 |
| Pages 静态请求 | 与访问量有关 | 不占上述 Worker 请求 | - | `/api/*` 仍由 Worker 计数 |

按当前 5 分钟上传路径线性放大，Workers 请求约在 206 台触顶，D1 行写入约在 111-166 台触顶，R2 Class A 约在 115 台触顶，R2 存储约在 208-227 台触顶。因此当前模式的**保守理论上限约为 110 台 VPS**，长期稳定规划建议控制在 **80 台以内**。

### 10 分钟上传：200 台 VPS

如果仅把 `NSTATUS_INTERVAL_SEC` 从 `300` 改为 `600`，1 秒采样、5 个 Ping、20 秒 Ping、72 小时历史、UI 和 API 均保持不变，则指标上传和基础 R2 操作约减半，但 Ping 配置刷新、更新检查和 R2 存储不会减半。

```text
指标上传       200 × 144 = 28,800 次/天
Ping 配置刷新  200 × 144 = 28,800 次/天
更新策略检查   200 ×  24 =  4,800 次/天
Cron                        1,440 次/天
状态页/后台预留              4,560 次/天
合计                        68,400 次/天
```

| Cloudflare 资源 | 200 台具体用量 | 免费额度 | 占用比例 | 说明 |
| --- | ---: | ---: | ---: | --- |
| Workers 请求 | 约 68,400 次/天 | 100,000 次/天 | 68.4% | 配置刷新和更新检查频率不变 |
| D1 行读取 | 约 600,000-1,200,000 行/天 | 5,000,000 行/天 | 12%-24% | 按 50 台区间的 4 倍估算 |
| D1 行写入 | 约 60,000-90,000 行/天 | 100,000 行/天 | 60%-90% | 接近高位，需保留重试余量 |
| D1 存储 | 通常低于 200 MB | 5 GB/账号 | 低于 4% | 单数据库仍受 500 MB 上限约束 |
| R2 Class A 写入 | 约 864,000 次/月 | 1,000,000 次/月 | 86.4% | 28,800 次/天 × 30 天 |
| R2 Class B 读取 | 约 864,000 次/月，另加图表读取 | 10,000,000 次/月 | 约 8.64% 起 | 访问量决定额外图表读取 |
| R2 存储 | 约 8.8-9.6 GB-month | 10 GB-month/月 | 88%-96% | 上传间隔不减少原始数据总量 |
| Agent Ping 点 | 4,320,000 点/天 | 批量随指标上传 | 0% 额外请求 | `200 × 5 × 86400 / 20` |
| Durable Object | 最多约 57,600 次区域探测调用/天 | 取决于区域目标 | - | `200 × 288`，仅非 `auto` 区域目标 |

纯操作额度数学上可以接近 220 台，但 R2 存储可能达到或超过 10 GB-month，D1 写入和 R2 Class A 也几乎没有余量。因此 10 分钟模式的**保守硬上限为 200 台**，长期稳定运行建议为 **150-180 台**。

10 分钟批次约包含 600 个指标点；当前 Worker 上限是 310 个点。实际切换前必须扩展批次上限、请求体限制和 Agent 重试队列，并完成压力测试。上传周期改变后最新状态最多可能延迟约 10 分钟，但不会减少 1 秒采样点或 Ping 点。

免费额度不是稳定 SLA。实际消耗取决于访问量、Target 数、索引、异常重试和历史查询范围。上线后应同时观察 Workers 请求、D1 `rows_read/rows_written`、R2 Class A/B 与 R2 日峰值存储；任意一项超过 80% 都应停止继续增加节点。

## 项目结构

```text
NIE-SLA/
├─ worker/                  Cloudflare Worker、D1/R2/DO、Cron、API
│  ├─ src/admin/            后台领域模块
│  ├─ src/metrics.js        Agent 遥测读写与 R2 合并格式
│  ├─ src/probe.js          HTTP/TCP 探测和漏检回填
│  └─ wrangler.toml         Wrangler 配置模板
├─ frontend/                Pages 状态页与独立管理后台
│  ├─ js/admin/             后台 API/交互模块
│  ├─ js/themes/            Classic/Cards 主题
│  └─ functions/api/        可选 Pages API 代理
├─ agent/                   Rust Agent、安装器、cftz、Python 外部探针
│  └─ src/                  平台、队列、更新器和调度实现
├─ docs/zh-CN/              中文完整教程
├─ docs/en/                 English guides
├─ tests/                   前端、安装器和 Secret 安全测试
└─ .github/workflows/       验证、多架构构建与 Release
```

## 开发与验证

```bash
bash test.sh
```

完整测试覆盖：

- Worker 所有 JS 语法和 utility tests。
- 前端模块依赖、导入 smoke 与 UI 数据帮助函数。
- 安装器 manifest 规则。
- Rust `fmt`、`check`、单元测试和 Linux amd64 构建。
- Shell 脚本语法与仓库卫生规则。
- Secret 与本地配置安全检查。

单独验证 Agent：

```bash
cd agent
cargo fmt -- --check
cargo check
cargo test
```

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [01 架构与组件](docs/zh-CN/01-architecture.md) | Worker、D1、R2、DO、Pages、Agent 的职责与数据流 |
| [02 Cloudflare 从零部署（新手完整教程）](docs/zh-CN/02-deployment.md) | 从零部署、概念解释、一键/手动、域名、Agent、验收与排障 |
| [03 后台管理](docs/zh-CN/03-admin.md) | Token/TOTP、Target、排序、主题和更新开关 |
| [04 Agent 安装与维护](docs/zh-CN/04-agent.md) | Linux/Windows、采样、队列、更新、卸载和日志 |
| [05 流量与账单](docs/zh-CN/05-traffic-billing.md) | 流量模式、额度、到期日、价格与币种 |
| [06 Telegram 告警](docs/zh-CN/06-alerts.md) | Bot、Chat ID、阈值、去重与测试 |
| [07 配置参考](docs/zh-CN/07-configuration.md) | Worker、Agent 和隐私环境变量 |
| [08 API 参考](docs/zh-CN/08-api.md) | Public、Admin、Agent API 与鉴权 |
| [09 运维排障](docs/zh-CN/09-operations.md) | 漏检、Latency、离线、版本、限流和容量排查 |
| [10 安全与免费额度](docs/zh-CN/10-security-free-tier.md) | 密钥、权限、用量和公开前审计 |
| [11 开发与发布](docs/zh-CN/11-development.md) | 本地测试、CI、多架构 Release 和版本流程 |
| [12 IPv6 专章](docs/zh-CN/12-ipv6-cloudflare-probe.md) | literal、AAAA、橙云、Workers Socket 限制 |

## 贡献与许可

提交 Issue 前请移除 Token、域名、IP、节点名称、Cloudflare ID 和日志中的 Authorization Header。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开披露可利用细节。

本项目采用 [MIT License](LICENSE)。自托管者需自行承担 Cloudflare、Telegram、网络与目标系统的使用成本、安全配置和合规责任。
