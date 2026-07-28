# 架构与数据流

NIE-SLA 新部署采用单 Worker 控制面。

```text
Worker + Static Assets
  |-- D1：配置、当前状态、SLA 桶、Session、告警状态
  |-- R2：Agent Metrics、Ping、状态快照、恢复前快照
  |-- Durable Objects：区域探测、每 Agent 小时遥测缓冲
  |-- Cron：每分钟调度

Rust Agent
  |-- 低权限遥测服务
  |-- 独立固定动作 root runner（Beta）
  |-- 仅主动 HTTPS 访问 Worker
```

## 四类状态

- Cloudflare HTTP/TCP：公网服务是否可达。
- Agent 心跳：VPS 是否仍在上报。
- Agent TCP Ping：VPS 到指定 TCP 目标的延迟。
- External Latency Agent：其他网络位置到公开 TCP 目标的延迟。

这些状态不能互相替代。公开日格对公网目标表示 Cloudflare SLA；无公开地址的 VPS 使用 Agent 在线记录。

## 写入分层

当前状态按分钟刷新，完整公开快照每 5 分钟写入 R2；读取快照时再覆盖 D1 最新状态，因此页面实时性不依赖快照写入频率。长期 SLA 使用 5 分钟 D1 桶，30 天状态优先读取 R2 状态对象中随探测增量维护的日汇总，只有状态落后才回查对应目标的 D1 原始桶。

高频 Metrics 与 Ping 先写入按 Agent ID 隔离的 Durable Object。当前小时直接从缓冲读取，小时结束并经过重试重叠窗口后合并为一个 R2 对象。这样 Agent 仍每 5 分钟上传且图表点不丢失，同时把 R2 Class A 从每次上报一次压缩为每 Agent 每小时一次。

流量使用当前周期行与每日账本。页面把最新网卡累计计数与 D1 周期行之间尚未落盘的差值实时合并，周期行最多每 30 分钟写一次；跨日、计数器重置和周期变化会立即落盘。修改流量重置日时根据保留的每日数据重新汇总。

## 兼容表

`targets` 继续作为旧 Agent 与现有管理代码的稳定标识来源，`nodes/checks` 作为结构化兼容表。迁移或恢复后会按原 Target ID 重建，不能擅自更换 ID。

## 旧架构兼容

旧 Pages + Worker 部署可无停机迁移到 Worker Static Assets。只要复用 D1、R2、Agent API 域名和加密材料，现有 Agent 协议不变。
