<div align="center">

# NIE-SLA

**运行在 Cloudflare 上的状态页与 VPS 探针**

Cloudflare Worker + D1 + R2 + Durable Objects + Rust Agent

[![Agent Version](docs/badges/agent-version.svg)](https://github.com/3257085208/NIE-SLA/releases)
[![Agent CI](https://github.com/3257085208/NIE-SLA/actions/workflows/agent-ci.yml/badge.svg)](https://github.com/3257085208/NIE-SLA/actions/workflows/agent-ci.yml)
[![License](docs/badges/license.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

[部署教程](docs/zh-CN/02-deployment.md) · [English](README.en.md) · [安全说明](SECURITY.md)

</div>

## 这是什么

NIE-SLA 把公开状态页、Cloudflare HTTP/TCP 检查和 VPS 系统数据放在一起。控制面运行在 Cloudflare，VPS 只安装一个主动上报的 Rust Agent，不需要额外购买中心服务器，也不需要开放 Agent 管理端口。

适合个人站点、小型服务和几十台 VPS 的统一监控。

## 一键部署

不需要先安装 Node.js、Wrangler 或数据库。

1. 点击上方 **Deploy to Cloudflare**。
2. 按页面提示登录 GitHub 和 Cloudflare 并完成授权。
3. 填写三个不同的随机 Secret。
4. 等待构建完成，打开 Cloudflare 给出的 `workers.dev` 地址。

需要填写：

| Secret | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 后台登录口令 |
| `AGENT_TOKEN` | 生成每台 Agent 的独立凭据 |
| `TOTP_ENCRYPTION_KEY` | 加密 TOTP 密钥 |

三项都建议使用密码管理器生成至少 32 字节的随机值，不能相同，也不要公开。

部署成功后，管理后台地址为：

```text
https://你的项目.你的账号.workers.dev/admin
```

使用 `ADMIN_TOKEN` 登录，然后按后台 UI 操作：

1. 打开“探针”。
2. 新增一台 VPS。
3. 点击该节点的部署按钮。
4. 复制 Linux 或 Windows 命令到对应机器执行。

首台 VPS 正常上报后，再按需配置 Ping、Latency Agent、Telegram、流量、主题和插件。

完整步骤见 [Cloudflare 一键部署](docs/zh-CN/02-deployment.md)。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| Cloudflare 探测 | HTTP、TCP、状态码、延迟、可选区域探测 |
| Rust Agent | 单文件程序，Linux 多架构与 Windows amd64 |
| VPS 数据 | CPU、内存、磁盘、负载、网络、IO、连接数、进程和线程 |
| 温度 | 支持 CPU、GPU、主板、硬盘和芯片组传感器 |
| 高频历史 | 本地 1 秒采样，默认 5 分钟批量上传到 R2 |
| 网络测量 | VPS TCP Ping、Cloudflare Latency、外部 Latency Agent |
| 节点管理 | 流量、价格、到期日、币种、标签、位置和 NodeQuality 报告 |
| 告警 | Telegram 离线、恢复、资源、流量和到期提醒 |
| 扩展 | 后台分别上传主题 ZIP 和插件 ZIP |
| 安全 | 每节点 scoped Token、可选 TOTP、更新文件 SHA-256 校验 |

## 监控链路

四类数据彼此独立：

| 链路 | 用途 |
| --- | --- |
| Cloudflare HTTP/TCP | 检查公网服务是否可达 |
| Agent 心跳与指标 | 判断 VPS 是否运行并采集系统数据 |
| Agent TCP Ping | 测量该 VPS 到指定目标的延迟 |
| External Latency Agent | 从家庭宽带或其他网络测量公开 TCP 目标 |

Agent 在线不代表目标端口一定能被 Cloudflare 访问，反过来也一样。

## 与常见方案的区别

| 类型 | 更适合 |
| --- | --- |
| Cloudflare uptime 工具 | 只监控网站、API 或端口，需要简单状态页 |
| 传统中心式探针 | 需要 Web 终端、批量命令和远程运维 |
| NIE-SLA | 需要 Cloudflare 外部视角、公开状态页和完整 VPS 数据，但不需要远程命令执行 |

NIE-SLA 不提供 Web Shell 或任意命令执行。它的 Agent 权限只用于采集、Ping、配置刷新和经过校验的更新。

## 数据存储

```text
Browser
   |
Cloudflare Worker + Static Assets
   |-- D1: 配置、状态、事件、聚合数据
   |-- R2: Agent Metrics、Ping、快照
   |-- Durable Objects: 可选区域探测
   ^
   |
Rust Agent on VPS
```

Agent 在本地保持 1 秒采样，默认每 5 分钟上传一批。原始 Metrics 与 Ping 主要写入 R2，不把每个采样点逐行写进 D1。

## 免费额度

默认配置下的保守规划：

| 规模 | 建议 |
| --- | --- |
| 1-50 台 | 适合 Cloudflare Free 日常使用 |
| 50-80 台 | 需要观察 D1 写入、R2 Class A 和访问量 |
| 80-110 台 | 接近免费额度边界，不建议无监控长期运行 |

5 分钟上传模式按当前模型的理论边界约为 110 台，稳定规划建议不超过 80 台。实际用量取决于访问量、重试、Ping 数量和历史保留时间。

额度参考：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[R2 Pricing](https://developers.cloudflare.com/r2/pricing/)。

## 安全要点

- `ADMIN_TOKEN`、`AGENT_TOKEN` 和 `TOTP_ENCRYPTION_KEY` 必须不同。
- 每台 Agent 使用与 Target 绑定的独立 Token。
- 后台支持 TOTP，Session 在 D1 中只保存哈希。
- 安装与自动更新会校验 manifest 和二进制 SHA-256。
- 公共接口会裁剪敏感字段并可掩码 IP/端口。
- 主题和插件包会检查 ZIP 路径、Manifest、内容类型、大小和哈希。

详细边界见 [安全与免费额度](docs/zh-CN/10-security-free-tier.md) 和 [SECURITY.md](SECURITY.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [一键部署](docs/zh-CN/02-deployment.md) | Cloudflare 按钮部署与首次添加 VPS |
| [后台使用](docs/zh-CN/03-admin.md) | Target、排序、TOTP、设置和更新 |
| [Agent](docs/zh-CN/04-agent.md) | 安装、日志、升级和卸载 |
| [告警](docs/zh-CN/06-alerts.md) | Telegram 与阈值 |
| [API](docs/zh-CN/08-api.md) | Public、Admin 与 Agent API |
| [运维排障](docs/zh-CN/09-operations.md) | 离线、漏检、限流和历史 |
| [External Latency Agent](docs/zh-CN/13-external-latency-agents.md) | 多网络测量节点 |
| [主题与插件](docs/zh-CN/14-extensions-developer-guide.md) | 扩展格式、权限和上传 |

## 本地验证

开发者克隆仓库后可运行：

```bash
bash test.sh
```

一键部署构建检查：

```bash
npm install
npm run check:deploy
```

## License

[MIT](LICENSE)
