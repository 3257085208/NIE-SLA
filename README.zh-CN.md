<p align="center">
  <img src="https://img.shields.io/github/v/release/3257085208/NIE-SLA?label=Agent%20Version&style=for-the-badge&color=159754" alt="Agent 版本">
  <img src="https://img.shields.io/badge/Worker-%E5%85%BC%E5%AE%B9-brightgreen?style=for-the-badge&logo=cloudflare&logoColor=white&color=F38020" alt="Worker 兼容">
  <img src="https://img.shields.io/github/languages/top/3257085208/NIE-SLA?style=for-the-badge&color=3572A5" alt="主要语言">
  <img src="https://img.shields.io/github/license/3257085208/NIE-SLA?style=for-the-badge&color=blue" alt="开源协议">
</p>

<p align="center">
  <img src="https://img.shields.io/github/contributors/3257085208/NIE-SLA?style=flat-square&color=orange" alt="贡献者">
  <img src="https://img.shields.io/github/commit-activity/m/3257085208/NIE-SLA?style=flat-square&color=159754" alt="提交活跃度">
  <img src="https://img.shields.io/github/repo-size/3257085208/NIE-SLA?style=flat-square&color=blue" alt="仓库大小">
  <img src="https://img.shields.io/github/stars/3257085208/NIE-SLA?style=social" alt="Stars">
  <img src="https://img.shields.io/github/forks/3257085208/NIE-SLA?style=social" alt="Forks">
</p>

# NIE-SLA — 自托管状态页 & VPS 遥测系统

**NStatus** 是一套基于 Cloudflare 的自托管服务监控与 VPS 遥测系统。它从 Cloudflare 边缘节点探测 HTTP/TCP 服务可用性，通过 Rust Agent 采集详细的 VPS 系统指标，追踪每台 VPS 的流量和计费信息，执行 TCP Ping 延迟检测，并通过 Telegram 发送告警——**全部运行在 Cloudflare 免费套餐上**。

> **无需服务器。** 所有组件运行在 Cloudflare Workers、D1、R2 和 Pages 上。Agent 只需出站 HTTPS，无需开放任何入站端口。

---

## 目录

- [系统架构](#系统架构)
- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [部署指南](#部署指南)
  - [1. 部署 Worker（后端）](#1-部署-worker后端)
  - [2. 部署 Frontend（前端面板）](#2-部署-frontend前端面板)
  - [3. 在 VPS 上安装 Agent](#3-在-vps-上安装-agent)
- [配置说明](#配置说明)
  - [Worker 环境变量](#worker-环境变量)
  - [Worker 密钥](#worker-密钥)
  - [Agent 环境变量](#agent-环境变量)
- [Agent](#agent)
  - [Rust Agent（推荐）](#rust-agent推荐)
  - [Python Agent（OrangePi / 低配设备）](#python-agentorangepi--低配设备)
  - [Agent 管理 CLI](#agent-管理-cli)
- [API 文档](#api-文档)
- [安全机制](#安全机制)
  - [Agent Token 权限隔离](#agent-token-权限隔离)
  - [二进制完整性校验](#二进制完整性校验)
  - [管理员认证](#管理员认证)
- [告警系统](#告警系统)
- [流量计费](#流量计费)
- [开发指南](#开发指南)
  - [运行测试](#运行测试)
  - [构建 Agent](#构建-agent)
  - [CI/CD](#cicd)
- [Cloudflare 免费套餐限额](#cloudflare-免费套餐限额)
- [开源协议](#开源协议)

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare 基础设施                           │
│                                                                   │
│  ┌─────────────┐     ┌──────────────────┐    ┌───────────────┐  │
│  │   Pages      │────▶│   Worker (API)   │────│  D1 数据库    │  │
│  │  (前端面板)  │     │                  │    │  (SQL 状态)   │  │
│  │              │     │  • API 路由      │    └───────────────┘  │
│  │ • 状态页面   │     │  • 定时探测      │                       │
│  │ • 管理后台   │     │  • 告警推送      │    ┌───────────────┐  │
│  │ • 安装脚本   │     │  • Agent 数据    │────│  R2 存储桶    │  │
│  │              │     │  • Schema 迁移   │    │ (历史+快照)   │  │
│  └──────┬──────┘     │                  │    └───────────────┘  │
│         │            │  ┌────────────┐  │                       │
│         │ 通过 Pages │  │  Durable    │  │    ┌───────────────┐  │
│         │ Functions  │  │  Objects    │  │    │  Cache API    │  │
│         │ 代理请求   │  │ (区域探测)  │──│────│ (状态/检查    │  │
│         │            │  └────────────┘  │    │  缓存)        │  │
│         ▼            └────────┬─────────┘    └───────────────┘  │
│  ┌──────────┐                 │                                  │
│  │ Telegram │◀────────────────┘                                  │
│  │  Bot API │  (通过 HTTP POST 发送告警)                         │
│  └──────────┘                                                    │
└─────────────────────────────────────────────────────────────────┘
        ▲                              ▲
        │ (仅出站 HTTPS)               │ (仅出站 HTTPS)
        │                              │
  ┌─────┴──────┐              ┌───────┴────────┐
  │ Rust Agent │              │  外部 Agent     │
  │ (VPS #1)   │              │  (OrangePi 等)  │
  │            │              │                 │
  │ • 系统指标 │              │ • HTTP/TCP      │
  │ • TCP Ping │              │   探测结果      │
  │ • 解锁检测 │              │                 │
  └────────────┘              └─────────────────┘
```

---

## 功能特性

| 分类 | 功能 |
|---|---|
| **监控探测** | 从 Cloudflare 边缘节点执行 HTTP/TCP 探测，可配置间隔（60s–24h） |
| **状态页面** | 公开面板，支持"卡片"主题（类 NodeGet）和"经典"主题 |
| **Agent** | Rust 二进制 — CPU、内存、磁盘、负载、网络速率、磁盘 I/O、连接数、TCP Ping |
| **流量统计** | 每台 VPS 月度流量统计及配额告警（总计/上行/下行/取大 四种模式） |
| **计费信息** | 每节点价格（USD/CNY）、到期追踪、计费周期支持 |
| **告警通知** | Telegram 通知：离线/恢复、资源阈值、到期提醒、流量配额 |
| **图表** | 基于 Chart.js 的延迟、CPU、内存、磁盘、网络、Ping 时间序列图 |
| **双因素认证** | TOTP 二次验证保护管理后台 |
| **区域探测** | 可选的跨区域分布式探测（通过 Durable Objects） |
| **安全** | 每台 VPS 专属 Token、二进制 SHA-256 校验、恒定时间比较认证 |
| **免费套餐** | 整个系统运行在 Cloudflare 免费套餐的慷慨限额内 |

---

## 快速开始

### 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm install -g wrangler`）
- [Rust](https://rustup.rs/)（构建 Agent 需要，可选 — Release 页面提供预编译二进制）

### 一键部署

```bash
git clone https://github.com/3257085208/NIE-SLA.git
cd NIE-SLA/worker
bash deploy.sh
```

脚本会引导你完成：
1. Wrangler 认证
2. D1 数据库创建
3. R2 存储桶创建
4. 设置 ADMIN_TOKEN 和 AGENT_TOKEN 密钥
5. Worker 部署
6. 前端 Pages 部署

部署完成后，访问 Pages URL 查看状态页面，访问 `/admin` 进入管理后台。

---

## 项目结构

```
NIE-SLA/
├── worker/                   # Cloudflare Worker 后端
│   ├── src/
│   │   ├── index.js          # 入口（fetch 请求处理器 + cron 定时任务）
│   │   ├── routes.js         # API 路由定义
│   │   ├── probe.js          # HTTP/TCP 探测引擎
│   │   ├── admin.js          # 目标 CRUD、Schema 迁移、安装命令生成
│   │   ├── auth.js           # Token 认证（含专属 Token 派生）
│   │   ├── admin_session.js  # Cookie 会话管理 + TOTP
│   │   ├── admin_ui.js       # 管理面板 HTML 服务
│   │   ├── admin_assets.js   # 管理面板内联 CSS/JS
│   │   ├── alerts.js         # Telegram 告警引擎
│   │   ├── metrics.js        # Agent 遥测数据接收与检索
│   │   ├── status.js         # 公开状态 API + R2 快照
│   │   ├── storage.js        # R2 读写辅助
│   │   ├── traffic.js        # 每 VPS 流量统计
│   │   ├── ratelimit.js      # 双层速率限制
│   │   ├── totp.js           # TOTP 双因素认证
│   │   ├── utils.js          # 共享工具函数
│   │   └── version.js        # 版本号
│   ├── tests/
│   │   └── utils.test.mjs    # 单元测试
│   ├── wrangler.toml         # Worker 配置
│   ├── deploy.sh             # 交互式部署脚本
│   └── targets-web-d1.sql    # D1 Schema 建表文件
│
├── frontend/                 # Cloudflare Pages 前端
│   ├── index.html            # 状态页面（SPA 单页应用）
│   ├── app.js                # 面板逻辑（卡片/经典 双主题）
│   ├── config.js             # 运行时 API 配置
│   ├── style.css             # 样式表（双主题）
│   ├── 404.html              # 自定义 404 页面
│   ├── functions/            # Pages Functions（API 代理）
│   │   ├── api/[[path]].js   # /api/* → Worker 代理
│   │   └── admin/[[path]].js # /admin/* → Worker 代理
│   ├── js/                   # 前端模块
│   │   ├── shared/           # 计费、格式化、HTML、流量辅助函数
│   │   └── themes/           # 卡片和详情主题模块
│   ├── assets/               # 静态资源（Logo、国旗、OS 图标）
│   ├── bin/                  # 预编译 Agent 二进制（GitHub Releases）
│   │   └── SHA256SUMS        # 二进制校验清单
│   ├── install.sh            # Linux 安装入口
│   ├── install.ps1           # Windows PowerShell 安装脚本
│   ├── setup.sh              # 交互式 Linux 安装
│   ├── quick-install.sh      # 非交互式安装
│   ├── update.sh             # Agent 更新脚本
│   └── cftz                  # Agent 管理 CLI
│
├── agent/                    # Rust Agent + Python 备选 Agent
│   ├── src/
│   │   └── main.rs           # Rust Agent 源码（单文件）
│   ├── Cargo.toml            # Rust 包配置
│   ├── Makefile              # 交叉编译构建目标
│   ├── bin/                  # 构建输出目录
│   ├── install.sh            # Linux 安装入口
│   ├── install.ps1           # Windows PowerShell 安装脚本
│   ├── setup.sh              # 交互式 Linux 安装
│   ├── quick-install.sh      # 非交互式安装
│   ├── update.sh             # Agent 更新脚本
│   ├── cftz                  # Agent 管理 CLI
│   ├── agent_orangepi.py     # Python 备选 Agent
│   ├── agent_orangepi.env.example  # Python Agent 环境变量模板
│   └── docs/                 # Agent 文档
│
├── docs/                     # 通用文档
├── tests/                    # 测试配置
├── cftz                      # Agent 管理 CLI（根目录副本）
├── test.sh                   # 项目级测试脚本
├── package.json              # Node.js ESM 声明
├── .github/workflows/        # GitHub Actions CI/CD
│   └── agent-ci.yml          # Agent 构建与发布工作流
├── README.md                 # 英文文档
└── README.zh-CN.md           # 你正在看的文件
```

---

## 部署指南

### 1. 部署 Worker（后端）

```bash
cd worker

# 设置密钥（必需）
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put TOTP_ENCRYPTION_KEY    # 可选，用于双因素认证

# 设置必需的环境变量
# 编辑 wrangler.toml 或使用命令：
npx wrangler deploy --var PUBLIC_WORKER_URL:"https://your-worker.your-subdomain.workers.dev"

# 部署
npx wrangler deploy
```

### 2. 部署 Frontend（前端面板）

```bash
cd frontend

# 创建 config.js 填入 Worker URL
echo 'window.NSTATUS_CONFIG = { apiBase: "https://your-worker.your-subdomain.workers.dev" };' > config.js

# 部署到 Cloudflare Pages
npx wrangler pages deploy ./ --project-name=nstatus
```

### 3. 在 VPS 上安装 Agent

**方式 A：从管理后台一键安装**

登录管理后台 `https://YOUR_PAGES.pages.dev/admin`，进入目标管理，点击任意目标的"安装 Agent"按钮获取预配置安装命令。

**方式 B：从 Release 页面安装**

```bash
# 下载并安装预编译二进制
curl -fsSL https://github.com/3257085208/NIE-SLA/releases/latest/download/install.sh | sudo sh

# 交互式安装会提示输入：
#   - API URL: https://your-worker.your-subdomain.workers.dev
#   - Agent Token:（从管理后台获取）
#   - Target ID: 你的 VPS 主机名
```

---

## 配置说明

### Worker 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PUBLIC_SITE_NAME` | `"NStatus"` | 状态页显示名称 |
| `PUBLIC_WORKER_URL` | `""` | Worker 公开 URL（必需） |
| `TIMEZONE_OFFSET_MINUTES` | `"480"` | 时区偏移分钟数（UTC+8 = 480） |
| `CONCURRENCY` | `"8"` | 最大并发探测数 |
| `MAX_TARGETS_PER_RUN` | `"60"` | 每次定时任务最大探测目标数 |
| `CHECKS_DEFAULT_LIMIT` | `"864"` | 默认检查历史条数 |
| `CHECKS_WINDOW_HOURS` | `"72"` | 默认检查历史窗口（小时） |
| `PUBLIC_MASK_IPS` | `"true"` | 公开状态中隐藏 IP 地址 |
| `AGENT_METRICS_RETENTION_HOURS` | `"6"` | Agent 指标 D1 保留时间 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `"72"` | Agent 指标 R2 保留时间 |
| `ALERT_MAX_MESSAGES_PER_RUN` | `"30"` | 每次运行最大告警消息数 |

### Worker 密钥

| 密钥 | 是否必需 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | 是 | 管理后台登录 Token |
| `AGENT_TOKEN` | 是 | 全局 Agent Token（用于生成每 VPS 专属 Token） |
| `TOTP_ENCRYPTION_KEY` | 否 | TOTP 密钥 AES-GCM 加密密钥 |
| `TELEGRAM_BOT_TOKEN` | 否 | Telegram Bot API Token（告警用） |

### Agent 环境变量

| 变量 | 是否必需 | 默认值 | 说明 |
|---|---|---|---|
| `NSTATUS_API_BASE` | 是 | — | Worker API URL |
| `NSTATUS_AGENT_TOKEN` | 是 | — | 专属/全局 Agent Token |
| `NSTATUS_AGENT_ID` | 否 | `hostname` | VPS 标识（需与管理后台目标 ID 一致） |
| `NSTATUS_AGENT_LABEL` | 否 | `hostname` | 显示标签 |
| `NSTATUS_INTERVAL_SEC` | 否 | `300` | 上报间隔（秒） |
| `NSTATUS_SAMPLE_SEC` | 否 | `1` | 本地采样间隔（秒） |
| `NSTATUS_PING_SEC` | 否 | `20` | TCP Ping 间隔（秒） |
| `NSTATUS_PING_TARGETS` | 否 | `*` | Ping 目标过滤器（`*` = 全部，或 `id1,id2`） |

---

## Agent

### Rust Agent（推荐）

独立的单文件 Rust 应用程序。使用 `musl` 静态链接 — 在任何 Linux 发行版上无需依赖即可运行。

**采集指标：**
- CPU 使用率（单核及整体）
- 内存和 Swap 使用率
- 磁盘使用率
- 负载均值（1m、5m、15m）
- 网络 I/O 速率（rx/tx bytes/sec）
- 磁盘 I/O 速率（read/write bytes/sec）
- TCP/UDP 连接数
- 进程数和线程数
- 系统运行时间
- VPS 信息（CPU 型号、核心数、架构、OS、内核、虚拟化类型）
- TCP Ping 延迟（自定义目标）
- 可选流媒体解锁检测（Netflix、Disney+ 等）

**从源码构建：**
```bash
cd agent
cargo build --release
# 或交叉编译所有平台：
make build-linux     # 6 种架构: amd64, arm64, armv7, armv6, armv5, 386
make build-windows   # Windows amd64
```

**预编译二进制**可在 [GitHub Releases](https://github.com/3257085208/NIE-SLA/releases) 下载。

### Python Agent（OrangePi / 低配设备）

适用于无法运行 Rust 二进制的 ARM 小板（OrangePi、树莓派）：

```bash
cp agent/agent_orangepi.env.example agent_orangepi.env
# 编辑 agent_orangepi.env 填入 API URL、Token 和目标 ID
python3 agent/agent_orangepi.py
```

Python Agent 在本地执行 HTTP/TCP 检查并上传批量结果。仅使用 Python 3 标准库 — 无需 pip 依赖。

### Agent 管理 CLI

```bash
cftz status       # 查看服务状态
cftz log 50       # 查看最近 50 行日志
cftz set          # 重新配置 Agent
cftz update       # 更新到最新二进制
cftz uninstall    # 完全卸载
```

---

## API 文档

完整 API 文档见 [docs/api.md](docs/api.md)。主要接口：

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| GET | `/api/status` | 公开 | 状态页数据（所有目标、摘要、事件） |
| GET | `/api/checks?target_id=X` | 公开 | 单目标检查历史 |
| GET | `/api/agent/metrics?agent_id=X` | 公开 | Agent 遥测时间序列 |
| POST | `/api/agent/metrics` | Agent | 提交 Rust Agent 指标 |
| POST | `/api/agent/pings` | Agent | 提交 TCP Ping 结果 |
| GET | `/api/agent/targets` | Agent | 获取探测目标列表 |
| GET | `/api/agent/ping-targets` | Agent | 获取 TCP Ping 目标列表 |
| GET | `/api/agent/install-command?target_id=X` | 管理员 | 生成安装命令 |
| GET | `/api/targets` | 管理员 | 列出所有目标 |
| POST | `/api/targets` | 管理员 | 创建目标 |
| PATCH | `/api/targets/:id` | 管理员 | 更新目标 |
| DELETE | `/api/targets/:id` | 管理员 | 删除目标 |
| POST | `/api/probe-now` | 管理员 | 触发即时探测 |
| POST | `/api/alerts/check` | 管理员 | 强制执行告警检查 |
| GET | `/api/stats` | 管理员 | 数据库统计信息 |

---

## 安全机制

### Agent Token 权限隔离

每台 VPS 拥有唯一专属 Token，由全局 `AGENT_TOKEN` 派生：

```
专属Token = "nst_" + sha256hex(AGENT_TOKEN + ":" + agent_id).slice(0, 48)
```

- 专属 Token 只能写入自己 `agent_id` 的指标和 Ping 数据
- 仍兼容使用全局 `AGENT_TOKEN` 的旧 Agent
- 管理后台安装命令自动生成专属 Token
- 专属 Token 无需存储 — 由全局 Token 确定性派生

### 二进制完整性校验

- 每个 Agent 二进制文件在 `bin/SHA256SUMS` 中记录 SHA-256 校验值
- 安装脚本在安装前先校验二进制文件再校验二进制
- 校验清单本身的哈希值已硬编码固定，防止清单被篡改
- 可通过 `NSTATUS_SHA256SUMS_SHA256` 覆盖用于自定义发布流程

### 管理员认证

- Bearer Token（`ADMIN_TOKEN`）
- Cookie 会话（`__Host-nstatus-admin`，24 小时有效期，HttpOnly Secure）
- 可选的 TOTP 双因素认证，密钥经 AES-GCM 加密存储
- 登录/TOTP 接口受 D1 持久化速率限制保护

---

## 告警系统

在管理后台或通过环境变量配置 Telegram 告警：

- **离线告警**：目标下线时通知，恢复时也通知
- **资源告警**：CPU、内存、磁盘、负载、网络速率、磁盘 I/O、进程数、线程数
- **到期告警**：VPS 到期前 N 天提醒
- **流量告警**：月度流量超过百分比或 GB 阈值时通知

告警去重支持可配置冷却时间（repeat_minutes）。支持每个目标独立启用/禁用及自定义阈值。

---

## 流量计费

每 VPS 月度流量追踪，支持 4 种计费模式：

| 模式 | 说明 |
|---|---|
| `total` | 上行 + 下行流量合计 |
| `tx` | 仅上行 |
| `rx` | 仅下行 |
| `max` | 取上行和下行中的较大值 |

- 流量周期与目标到期日对齐
- 配额和计费模式可按目标配置
- 流量增量从 Agent 原始网络计数器累积计算
- 在状态页中以进度条形式展示

---

## 开发指南

### 运行测试

```bash
./test.sh
```

检查内容：
- Worker JS 语法（14 个源文件）
- 前端 JS 语法（3 个源文件 + 共享模块导入）
- Rust Agent 格式化、编译、Linux amd64 构建
- Shell 脚本语法（所有安装器、更新脚本、CLI）
- 仓库规范（无真实目标数据、安全的安装命令等）

### 构建 Agent

```bash
cd agent
cargo build --release                    # 当前平台构建
make build-linux                         # 全部 6 种 Linux 架构
make build-windows                       # Windows amd64
make clean                               # 清理构建产物
```

### CI/CD

GitHub Actions 工作流（`.github/workflows/agent-ci.yml`）：
- `cargo fmt -- --check` 代码风格检查
- 7 个平台的交叉编译
- 推送 Tag（`v*`）时自动创建 GitHub Release

---

## Cloudflare 免费套餐限额

整个系统设计用于 Cloudflare 免费套餐范围内：

| 资源 | 免费限额 | 典型使用量 |
|---|---|---|
| Worker 请求 | 10 万/天 | ~17,280（24h × 60min × 12 次定时探测） |
| Worker CPU | 10ms/请求 | 异步批处理下远低于限额 |
| D1 行读取 | 500 万/天 | ~5 万（典型） |
| D1 行写入 | 10 万/天 | ~1 万（典型） |
| D1 存储 | 5 GB | ~5-10 MB（典型） |
| R2 存储 | 10 GB | ~100-500 MB（典型，含保留策略） |
| R2 Class A 操作 | 100 万/月 | ~10 万（典型） |
| R2 Class B 操作 | 1000 万/月 | ~50 万（典型） |

---

## 开源协议

[MIT License](LICENSE)

---

## 参与贡献

代码规范和发布流程请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

**Rust + Cloudflare Workers 构建**
