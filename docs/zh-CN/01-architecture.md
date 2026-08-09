# 架构与数据流

NIE-SLA 的部署形态是一个 Cloudflare Worker 应用同时承载静态前端、管理后台、API 与定时任务。控制面没有独立服务器。

```text
Worker + Static Assets
  |-- D1：配置、当前状态、SLA 桶、会话、告警状态
  |-- R2：指标历史、Ping 历史、状态快照、恢复前快照
  |-- Durable Objects：区域探测（REGION_PROXY）、每 Agent 小时遥测缓冲（TELEMETRY_BUFFER）
  |-- Cron：每分钟调度

Rust Agent
  |-- 低权限遥测服务
  |-- root Manager（只执行两个固定 Beta 动作）
  |-- 仅主动 HTTPS 访问 Worker
```

## 四类状态

系统同时维护四类互相独立的状态：

- Cloudflare HTTP/TCP 探测：公网服务是否可达。
- Agent 在线：VPS 是否仍在按周期上报。
- Agent TCP Ping：VPS 到指定 TCP 目标的延迟。
- External Latency Agent：其他网络位置到公开 TCP 目标的延迟。

它们不能互相替代。没有公网地址的 VPS 用 Agent 在线记录代替探测结果；Agent 在线也说明不了 Cloudflare 能访问 VPS 的端口。

## 写入分层

当前状态按分钟刷新，完整公开快照每 5 分钟写一次 R2；读取响应时用 D1 最新状态覆盖快照，页面实时性不依赖快照写入频率。长期 SLA 使用 5 分钟 D1 桶；30 天内的状态优先读取 R2 中随探测增量维护的日汇总，只有落后时才按目标回查 D1 原始桶。

高频 Metrics 与 Ping 先写入按 Agent ID 隔离的 Durable Object。当前小时直接从缓冲读取，小时结束后经过重试重叠窗口合并为一个 R2 对象。Agent 的上传间隔不变，但 R2 Class A 从每次上报一次压缩为每 Agent 每小时一次。

流量使用当前周期行与每日账本。页面把最新网卡累计计数与 D1 周期行之间尚未落盘的差值实时合并，周期行最多每 30 分钟写一次；跨日、计数器重置和周期变化会立即落盘。修改流量重置日时按保留的每日数据重新汇总。

## 兼容表

`targets` 继续作为旧 Agent 与现有管理代码的稳定标识来源，`nodes/checks` 是结构化兼容表。迁移或恢复后会按原 Target ID 重建，不能擅自更换 ID。

## 旧架构兼容

旧 Pages + Worker 部署可以无停机迁移到 Worker Static Assets。复用 D1、R2、Agent API 域名与加密材料，Agent 协议不变，已安装的 Agent 无需重装。
