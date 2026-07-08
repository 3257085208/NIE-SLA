# 08 API 参考

## 认证

后台接口使用 `Authorization: Bearer ADMIN_TOKEN`，启用 TOTP 后还需要 `x-admin-session`。Agent 接口使用 `Authorization: Bearer AGENT_TOKEN`。

## 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 健康检查 |
| GET | `/api/status?days=30` | 首页状态数据 |
| GET | `/api/checks?target_id=ID&hours=72` | 目标历史 |
| GET | `/api/agent/metrics?agent_id=ID` | Agent 指标 |
| GET | `/api/agent/pings?agent_id=ID` | Agent Ping |
| GET | `/api/colo-echo` | 当前 CF colo |

## 后台接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/targets` | 列表/新增探针 |
| PATCH/DELETE | `/api/targets/:id` | 更新/删除探针 |
| POST | `/api/probe-now` | 立即探测 |
| GET/PATCH | `/api/settings` | 前端设置 |
| GET/PATCH | `/api/alerts/settings` | 报警设置 |
| POST | `/api/alerts/test` | 发送 TG 测试 |
| POST | `/api/alerts/check` | 立即报警检查 |
| GET/POST | `/api/ping-targets` | Ping 管理 |
| POST | `/api/totp/setup` | 创建 TOTP |
| POST | `/api/totp/verify` | 验证 TOTP |
| POST | `/api/totp/disable` | 关闭 TOTP |

## Agent 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/targets` | 获取探测目标 |
| POST | `/api/agent/results` | 上报探测结果 |
| POST | `/api/agent/metrics` | 上报系统指标 |
| GET | `/api/agent/ping-targets` | 获取 Ping 目标 |
| POST | `/api/agent/pings` | 上报 Ping 结果 |
