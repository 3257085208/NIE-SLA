# 08 API 与认证参考

API 返回 JSON。生产环境只通过 HTTPS 调用。

## 认证类型

### 公开接口

无需 Token，但有 IP 限流和脱敏。示例：

```bash
curl -fsSL https://YOUR-API/api/status
```

### Admin

```http
Authorization: Bearer ADMIN_TOKEN
X-Admin-Session: TOTP_SESSION
```

未启用 TOTP 时不需要 session；启用后管理接口要求两者。不要把 Header 命令提交到 Shell 历史或公开日志。

### Agent

```http
Authorization: Bearer SCOPED_AGENT_TOKEN
```

Token 与 `agent_id` 绑定。身份不匹配返回 401/403。

## 健康与公开读取

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | Worker 名称、版本、时间 |
| GET | `/api/status` | 目标、最新状态、日汇总、事件 |
| GET | `/api/checks?target_id=ID&hours=72&limit=864` | 5 分钟明细和 Agent series |
| GET | `/api/agent/metrics?agent_id=ID&hours=6` | Agent 指标 |
| GET | `/api/agent/pings?agent_id=ID&hours=6` | Ping 历史 |
| GET | `/api/colo-echo` | 当前请求 colo 调试 |

## Agent 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/metrics` | 上传指标批次 |
| GET | `/api/agent/update-policy?agent_id=ID` | 读取自动更新策略 |
| GET | `/api/agent/ping-targets?agent_id=ID` | 拉取 Ping 目标 |
| POST | `/api/agent/pings` | 上传 Ping 批次 |
| GET | `/api/agent/targets?agent_id=ID` | 外部 Agent 拉取目标 |
| POST | `/api/agent/results` | 外部 Agent 上传探测结果 |

请求体有大小限制。不要一次上传无限历史；Agent 会控制批次和队列。

## Admin 接口

### 登录与 TOTP

| 方法 | 路径 |
| --- | --- |
| GET | `/api/login` |
| POST | `/api/totp/setup` |
| POST | `/api/totp/verify` |
| POST | `/api/totp/disable` |

### 目标

| 方法 | 路径 |
| --- | --- |
| GET/POST | `/api/targets` |
| PATCH/DELETE | `/api/targets/:id` |
| PATCH | `/api/targets/order` |
| POST | `/api/probe-now` |
| POST | `/api/sync-targets` |

创建 TCP 示例（占位 Token）：

```bash
curl -X POST https://YOUR-API/api/targets \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"name":"Example VPS","group_name":"VPS","type":"tcp","target_host":"probe.example.com","target_port":443,"probe_region":"apac"}'
```

启用 TOTP 后还需 `X-Admin-Session`。更推荐使用后台，避免 Token 留在 Shell 历史。

### 设置、报警和维护

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PATCH | `/api/settings` | 公开主题、自动更新等 |
| GET/PATCH | `/api/alerts/settings` | 报警设置 |
| POST | `/api/alerts/test` | 测试 Telegram |
| POST | `/api/alerts/check` | 立即计算报警 |
| GET | `/api/stats` | 存储统计 |
| POST | `/api/maintenance/cleanup` | 手动清理 |
| GET | `/api/debug/latency-health` | Latency 健康诊断 |
| GET | `/api/agent/install-command?target_id=ID` | 生成 scoped 安装命令 |

## 常见状态码

| 状态 | 含义 |
| --- | --- |
| 200/201 | 成功 |
| 400 | 字段或 JSON 无效 |
| 401 | 缺少/错误 Token 或 TOTP session |
| 403 | Token 身份与 Agent ID 不匹配 |
| 404 | 路由/目标不存在 |
| 405 | 方法错误 |
| 413 | 请求体过大 |
| 429 | 限流 |
| 500 | Worker 内部异常 |

## 缓存

公开读取可能返回短缓存；Admin/Agent 写接口使用 `no-store`。调用者不应依靠公开接口实现强一致事务。

## 兼容与版本

API schema 会增加字段。客户端应忽略未知字段，不要因为新增字段失败。删除/重命名字段应作为明确版本变更处理。
