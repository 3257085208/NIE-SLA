# 01 架构与组件

NIE-SLA 采用“Cloudflare 托管控制面 + VPS 主动上报”的结构。公网入口只有 Cloudflare Worker 和 Pages，VPS 不开放任何入站端口。

```text
用户浏览器 -> Cloudflare Pages -> Cloudflare Worker
                               |-- D1：目标、最新状态、事件、后台设置、报警状态、速率限制
                               |-- R2：状态快照、Agent 高频指标、Ping 历史
                               |-- Durable Objects：按 Cloudflare 区域执行探测
Rust Agent --------------------^  仅主动 HTTPS 上报
```

## Worker

Worker 是系统核心，负责公开 API、后台 API、Cron 定时任务、D1/R2 读写、报警判断和安装命令生成。公开 API 面向状态页，后台 API 需要 `ADMIN_TOKEN` 和可选 TOTP，Agent API 需要 `AGENT_TOKEN`。

## Frontend

Frontend 是 Cloudflare Pages 静态站点，包括首页状态页、卡片主题、后台管理页、安装脚本、Windows/Linux 安装器和 Agent 二进制分发文件。

## Agent

Agent 是 Rust 单文件二进制，默认每 1 秒采样系统指标，每 20 秒执行 TCP Ping，每 300 秒批量上报。运行时使用原生 Rust HTTPS 客户端，不通过 `curl` / `wget` 调 Worker API。

## 数据流

1. 管理员在后台添加目标。
2. Agent 获取 Ping 目标并采集系统指标。
3. Agent POST 到 `/api/agent/metrics`。
4. Worker 更新 D1 最新状态，写入 R2 高频历史，并累计流量。
5. Worker cron 判断离线、阈值、到期和流量报警。
6. 首页从 `/api/status` 读取公开数据。

## 为什么不默认 WebSocket

WebSocket 能更实时，但在 Workers 上会增加长连接、Durable Object 状态和额度复杂度。离线报警通常只需要 1～5 分钟级精度，所以周期 HTTP 上报更稳、更省、更适合 50 台 VPS 级别的免费额度目标。
