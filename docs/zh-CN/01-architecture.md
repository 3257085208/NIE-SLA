# 01 架构与数据流

本文解释系统为什么拆成 Worker、Pages、D1、R2、Durable Objects 和 Agent，以及一条数据从采集到前端展示经历了什么。

## 设计目标

NIE-SLA 同时解决四类问题：

1. 从外部判断网站或端口是否可访问。
2. 判断 VPS 本身是否还在运行。
3. 收集 VPS 内部资源和网络指标。
4. 在 Cloudflare 免费额度内保存足够的历史。

单靠 HTTP/TCP 探测无法看到 CPU、内存；单靠 Agent 又无法证明外部用户能访问服务。因此系统故意保留多条相互独立的证据链。

## 组件职责

### Cloudflare Pages

Pages 托管公开首页、图表、后台和 Agent 下载文件。浏览器通过 Pages Functions 或配置的 API Base 请求 Worker。

Pages 不保存业务状态。刷新页面后，目标、状态和图表数据都重新从 Worker 获取。

### Cloudflare Worker

Worker 是控制面和 API：

- 处理公开状态接口。
- 验证 Admin/Agent Token 与 TOTP session。
- 每 5 分钟调度 HTTP/TCP 探测。
- 接收 Agent 指标和 Ping 批次。
- 更新 D1 最新状态与聚合桶。
- 写入和读取 R2 高频历史。
- 判断 Telegram 报警。
- 生成每个节点专用的 Agent 安装命令。

### D1

D1 适合结构化、小记录、需要 SQL 查询的状态：

- `targets`：监控目标和排序。
- `latest_status`：每个目标最新 CF 探测状态。
- `check_buckets`：5 分钟桶。
- `daily_summaries`：每日成功率聚合。
- `incident_events`：故障与恢复事件。
- `agent_metrics_state`：每个 Agent 最新指标。
- `agent_traffic_monthly`：月流量累计。
- `ping_targets`：后台配置的 Ping 目标。
- `app_meta`：设置、锁、定时任务诊断和 TOTP 元数据。
- `rate_limits`：跨实例限流状态。

表结构会由 `ensureV6Schema()` 幂等创建和迁移。不要手工删除列来“降级”。

### R2

R2 用于不适合逐条写入 D1 的高频数据：

- Agent 指标小时对象。
- Agent Ping 历史。
- 状态快照和归档。

一台 Agent 每秒采样，如果每个点都写一行 D1，50 台机器一天可能产生数百万次写入。批量写入 R2 能显著降低成本。

### Durable Objects

`ProbeRegion` 用于根据 `probe_region` 创建具有 location hint 的对象，并在对象内部执行探测。location hint 是调度提示，不是固定到某一个机房的 SLA 保证。

区域代码示例：`wnam` 表示北美西部，`apac` 表示亚太。实际 Cloudflare colo 可能随平台调度变化。

### Rust Agent

Agent 运行在 VPS 内部：

- 默认每 1 秒采集系统指标。
- 默认每 20 秒执行受管 TCP Ping。
- 默认约每 300 秒批量上报。
- 上传失败时使用有界队列缓存。
- 周期检查后台自动更新策略。
- 不开放管理端口，不接受 Worker 主动连接。

## 三条数据流

### CF 可用性

```text
Cron
  -> 读取启用目标
  -> 根据区域选择 Worker/DO
  -> fetch() 或 cloudflare:sockets connect()
  -> 写入 5 分钟桶
  -> 更新 latest_status、daily summary、incident
  -> 前端显示 CF Latency 和日色块
```

一次真实失败与一次漏检不同：

- 真实失败：探测函数执行并返回 `ok=0`。
- 漏检：某个应该存在的 5 分钟桶没有真实结果，系统补写 synthetic missed point。

当前默认 `CONCURRENCY=40`，33 个目标可以单批执行，减少后续批次在 Cron 生命周期内无法完成的问题。

### Agent 指标

```text
1 秒采样线程
  -> 本地内存/磁盘队列
  -> 每 300 秒组织上传批次
  -> POST /api/agent/metrics
  -> 校验 scoped token 与 agent_id
  -> 最新状态写 D1
  -> 高频历史写 R2
  -> 前端按窗口读取和抽样
```

Agent 在线判定看最后上报时间。默认超过 900 秒无上报才离线，避免一次上传失败造成状态闪烁。

### Agent Ping

```text
Agent 定期拉取 /api/agent/ping-targets
  -> 从 VPS 发起 TCP 连接
  -> 按 NSTATUS_PING_SEC 采集
  -> POST /api/agent/pings
  -> R2/D1 状态
  -> 前端 Ping 行与图表
```

它测量的是“VPS 到目标”，不是“Cloudflare 到 VPS”。

## 状态来源规则

对于有 Agent 指标的 TCP/VPS 目标：

- 卡片在线/离线优先使用 Agent 心跳。
- CF Latency 仍使用 `latest_status` 的真实外部探测。
- CF 日色块仍表示 Cloudflare 可达性。

对于 Web/HTTP 目标：

- 没有 Agent 概念。
- 在线状态、Latency 和色块都来自 CF HTTP 探测。

## 缓存与最终一致性

公开状态使用短时间缓存以降低 D1/R2 读取。部署或修改目标后，页面可能需要几十秒才显示新状态。使用强制刷新只能清浏览器缓存，不能跳过 Worker 内部缓存。

Agent 上传、R2 历史写入、状态快照和 Pages 静态部署也不是同一个事务，因此短时间内最新卡片与历史图表可能相差一个批次，这是正常的最终一致性。

## 安全边界

- 浏览器公开接口只能读取脱敏数据。
- Admin API 需要 Admin Token；启用 TOTP 后还需要有效 session。
- 每台 VPS 使用从主 Agent Token 派生的 scoped Token。
- scoped Token 只允许以绑定的 `agent_id` 上报。
- Agent Token 使用常量时间比较。
- 安装器验证 manifest 和二进制哈希。
- Agent API 默认必须 HTTPS。

## 为什么不使用持续 WebSocket

本项目重点是几十台 VPS 的周期监控，不要求毫秒级实时控制。持续连接会增加 Worker duration、连接数、重连状态和移动网络复杂度。1 秒本地采样配合批量上传能保留颗粒度，同时把 Cloudflare 请求量控制在可接受范围。

## 下一步

- [02 Cloudflare 部署](02-deployment.md)
- [04 Agent 安装与维护](04-agent.md)
- [12 IPv6、AAAA 与 CF TCP 探测](12-ipv6-cloudflare-probe.md)
