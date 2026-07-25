# 08 API 与认证参考

API 返回 JSON。生产环境只通过 HTTPS 调用。

## 认证类型

### 公开接口

无需 Token，但有 IP 限流和脱敏。示例：

```bash
curl -fsSL https://YOUR-API/api/status
```

### Admin

账号密码或 GitHub OAuth 只用于登录，登录成功后所有 Admin 接口统一使用：

```http
X-Admin-Session: ADMIN_SESSION
```

密码不会作为 Bearer Token 重复发送。Session 原文只保存在当前标签页，D1 保存 SHA-256 哈希与过期时间。

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
| GET | `/api/latency?target_id=ID&hours=24` | 外部 Latency 节点历史 |
| GET | `/api/colo-echo` | 当前请求 colo 调试 |
| GET | `/api/nq/:target_id` | 启用 TCP/VPS 探针的解析后 NodeQuality 报告 |

版本化开发接口使用 `/api/v1`，完整兼容约定见 [14 主题、插件与开发者 API](14-extensions-developer-guide.md)。

`/api/nq/:target_id` 也兼容 `/api/nodequality/:target_id`。响应包含报告时间、原报告链接、ANSI 文本 tabs 和图片 tabs，不包含后台保存的原始全文；无报告、HTTP 目标或已禁用目标返回 `404`。

## Agent 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/metrics` | 上传指标批次 |
| GET | `/api/agent/update-policy?agent_id=ID` | 读取自动更新策略 |
| GET | `/api/agent/ping-targets?agent_id=ID` | 拉取 Ping 目标 |
| POST | `/api/agent/pings` | 上传 Ping 批次 |
| GET | `/api/agent/targets?agent_id=ID` | Rust Agent 拉取自身目标配置 |
| POST | `/api/agent/results` | Rust Agent 上传可用性结果 |
| GET | `/api/latency-agent/targets?node_id=ID` | 外部 Latency Agent 拉取公开 TCP 目标 |
| POST | `/api/latency-agent/results` | 外部 Latency Agent 上传结果 |
| GET | `/api/latency-agent/update-policy?node_id=ID` | 外部 Latency Agent 读取自动更新策略 |

请求体有大小限制。不要一次上传无限历史；Agent 会控制批次和队列。

## Admin 接口

### 登录与 TOTP

| 方法 | 路径 |
| --- | --- |
| GET | `/api/auth/config` |
| POST | `/api/auth/login` |
| GET | `/api/auth/github/start` |
| GET | `/api/auth/github/callback` |
| POST | `/api/auth/github/complete` |
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

账号密码登录示例：

```bash
curl -X POST https://YOUR-API/api/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"YOUR_PASSWORD"}'
```

返回中的 `session_id` 只应放在临时环境变量或安全客户端中。创建 TCP 示例：

```bash
curl -X POST https://YOUR-API/api/targets \
  -H 'X-Admin-Session: YOUR_ADMIN_SESSION' \
  -H 'Content-Type: application/json' \
  --data '{"name":"Example VPS","group_name":"VPS","type":"tcp","target_host":"probe.example.com","target_port":443,"probe_region":"apac"}'
```

启用 TOTP 时登录请求还需提交 `totp`。更推荐使用后台，避免密码或 Session 留在 Shell 历史。

### 设置、报警和维护

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PATCH | `/api/settings` | 公开主题、前端外观与文案、自动更新等 |
| GET/PATCH | `/api/alerts/settings` | 报警设置 |
| POST | `/api/alerts/test` | 测试 Telegram 或邮件；body 使用 `channel` |
| POST | `/api/alerts/check` | 立即计算报警 |
| GET | `/api/system/update` | 读取当前版本、官方稳定版本与站内更新日志 |
| GET/PATCH | `/api/auth/account` | 读取或修改管理员账号；PATCH 需要当前密码，启用 TOTP 时还需验证码 |
| GET | `/api/stats` | 存储统计 |
| POST | `/api/maintenance/cleanup` | 手动清理 |
| GET | `/api/debug/latency-health` | Latency 健康诊断 |
| GET | `/api/agent/install-command?target_id=ID` | 生成 scoped 安装命令 |
| GET | `/api/latency-agents` | 列出外部 Latency 节点 |
| POST | `/api/latency-agents` | 创建外部 Latency 节点 |
| PATCH/DELETE | `/api/latency-agents/:id` | 编辑、停用或删除节点 |
| GET | `/api/latency-agent/install-command?node_id=ID` | 生成节点 scoped 安装命令 |
| GET | `/api/themes/manage` | 列出已安装主题 |
| POST | `/api/themes/upload` | 上传并校验主题 ZIP，只接受 `type: theme` |
| PATCH/DELETE | `/api/themes/:id` | 启停或删除主题 |
| GET | `/api/plugins/manage` | 列出已安装插件 |
| POST | `/api/plugins/upload` | 上传并校验插件 ZIP，只接受 `type: plugin` |
| PATCH/DELETE | `/api/plugins/:id` | 启停或删除插件 |

公开扩展注册表为 `GET /api/extensions`，启用后的包文件由 `GET /api/extensions/file/:id/:path` 提供。扩展文件接口不接受任意 R2 key，只能读取注册表中启用包的清单内文件。

旧 `/api/extensions/manage`、`/api/extensions/upload` 和 `/api/extensions/:id` 暂时保留兼容，但新后台和第三方管理工具必须使用分类型接口。

`GET /api/settings` 的 `appearance` 是经过服务端校验并补全默认值的公开对象。管理端可用 `PATCH /api/settings` 提交 `{ "appearance": { ... } }`；未知字段不会进入公开响应，URL、颜色、枚举、布尔值和图片尺寸会被标准化。公开首页从 `/api/status` 的 `frontend.appearance` 读取同一对象，`lite=1` 也不会删除它。

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
