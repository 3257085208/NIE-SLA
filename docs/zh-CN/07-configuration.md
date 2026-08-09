# 配置参考

配置分四类：Worker vars、Worker secrets、后台 D1 设置与 Agent 环境变量。Secret 一律通过 Wrangler Secrets 设置，不要放进 `[vars]`、`.env` 或前端源码。

## Worker 核心 vars

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `PUBLIC_SITE_NAME` | `NIE-SLA` | 公开站点名称 |
| `PUBLIC_WORKER_URL` | Worker HTTPS URL | 区域/安装地址回退 |
| `TIMEZONE_OFFSET_MINUTES` | `480` | UTC+8，影响每日桶与归档 |
| `CONCURRENCY` | `40` | 单轮并发目标数 |
| `MAX_TARGETS_PER_RUN` | `20` | 每分钟持久检查目标上限；默认五分钟覆盖 100 个目标 |
| `FAST_STATUS_ENABLED` | `true` | R2 轻量当前状态探测 |
| `FAST_STATUS_INTERVAL_SEC` | `60` | 当前状态探测间隔，限 60–300 秒 |
| `FAST_STATUS_MAX_TARGETS` | `50` | 无持久检查时每分钟最多快速探测目标数，限 1–50 |
| `STATUS_SNAPSHOT_EVERY_SEC` | `300` | 完整 R2 状态快照间隔 |
| `CHECKS_DEFAULT_LIMIT` | `864` | 明细默认上限 |
| `CHECKS_WINDOW_HOURS` | `72` | 明细默认窗口 |
| `PUBLIC_MASK_IPS` | `true` | 公开接口掩码 IP |
| `PUBLIC_HIDE_PORTS` | 按需 | 公开接口隐藏端口 |
| `PUBLIC_STATUS_AGENT_DETAILS` | `false` | 是否公开主机名、Agent 版本、精确容量/在线时长、系统与硬件指纹及流量明细；仅兼容旧主题时开启 |
| `PUBLIC_STATUS_UNLOCK_DETAILS` | `false` | 是否公开逐节点流媒体/IP 解锁明细 |
| `PUBLIC_STATUS_STORAGE_DETAILS` | `false` | 是否公开 D1/R2 存储模式及状态快照键名 |
| `INCIDENTS_TO_D1` | `true` | 事件写 D1 |
| `RATE_LIMIT_D1` | `true` | 使用 D1 做跨实例限流 |
| `MISSED_WRITE_BACKFILL_MAX_BUCKETS` | `6` | 最多补写漏检桶 |
| `ALERT_MAX_MESSAGES_PER_RUN` | `30` | 单轮告警上限 |
| `DEVELOPER_API_ORIGINS` | 空 | `/api/v1` 浏览器调用的精确 Origin 逗号列表，不支持 `*` |

三个 `PUBLIC_STATUS_*_DETAILS` 开关默认关闭。关闭 Agent 详情时，公开状态与指标 API 仍返回 CPU/内存/磁盘百分比、负载和当前收发速率，但不返回可用于识别服务器的精确信息；修改这些开关会使用独立缓存键，不会复用其他隐私模式的缓存。

## 指标与历史 vars

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_OFFLINE_AFTER_SEC` | `900` | Agent 离线阈值，限 120–3600 |
| `AGENT_AVAILABILITY_RETENTION_DAYS` | `90` | Agent 心跳日可用率保留天数，限 30–180 |
| `AGENT_METRICS_RETENTION_HOURS` | `6` | D1 临时指标保留 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 高频历史保留 |
| `AGENT_METRICS_POINTS_PER_REPORT` | `6` | 报告抽样点控制 |
| `AGENT_METRICS_TO_D1` | `false` | 高频指标写 D1（会显著增加写入量） |
| `AGENT_PINGS_TO_D1` | `false` | Ping 高频历史写 D1 |
| `PING_HISTORY_RETENTION_HOURS` | `6` | D1 Ping 临时历史 |
| `AGENT_CREDENTIAL_TOUCH_SEC` | `21600` | 每节点 Token 最近使用时间的最小写入间隔 |
| `TRAFFIC_PERSIST_INTERVAL_SEC` | `1800` | 流量周期行最大落盘间隔；页面合并未落盘差值 |

`TELEMETRY_BUFFER` Durable Object 绑定属于默认架构必需项。它不改变 Agent 的 5 分钟上传间隔；当前小时直接从缓冲读取，结束后按小时写入 R2。删除绑定会回退到兼容的逐上报 R2 写入，但不再适合 100 台免费额度预算。

## 安装与更新 vars

| 名称 | 说明 |
| --- | --- |
| `PUBLIC_AGENT_INSTALL_BASE` | 安装脚本与 `bin/` 的公开 HTTPS Base |
| `PUBLIC_AGENT_API_BASE` | Agent 上报 API Base |
| `AGENT_LATEST_VERSION` | Worker 返回的最新版本，如 `v1.1.12` |
| `NSTATUS_SHA256SUMS_SHA256` | 发布 manifest 自身的 SHA-256 |
| `AGENT_AUTO_UPDATE_DEFAULT` | 后台无设置时的默认策略，默认 `true` |
| `AGENT_UPDATE_CHECK_SEC` | Agent 策略检查建议间隔 |
| `AGENT_PING_SEC` | 安装命令默认 Ping 间隔 |

## Worker secrets

| 名称 | 必需 | 用途 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 新部署必需 | 后台密码；旧部署可暂时回退 `ADMIN_TOKEN` |
| `TOTP_ENCRYPTION_KEY` | 新部署必需 | TOTP、可恢复每节点 Token 与默认通知密钥的长期加密材料；至少 32 位，不随管理员密码轮换 |
| `PREVIOUS_ENCRYPTION_KEY` | 轮换期可选 | 上一把长期密钥；迁移成功后移除 |
| `AGENT_TOKEN` | 仅旧部署兼容 | 旧版全局及派生 scoped Token；新部署不要配置 |
| `ALERT_ENCRYPTION_KEY` | 可选 | 告警凭据独立长期密钥；未配置时用 `TOTP_ENCRYPTION_KEY` |
| `TELEGRAM_BOT_TOKEN` | 可选 | 环境配置 TG Bot |
| `RESEND_API_KEY` | 可选 | 环境配置 Resend 邮件 API |
| `GITHUB_OAUTH_CLIENT_SECRET` | 可选 | GitHub OAuth App secret |
| `NQ_IMGBED_URL` | 仅官方服务 | 维护者图床完整上传地址，必须公网 HTTPS 且以 `/upload` 结尾 |
| `NQ_IMGBED_TOKEN` | 仅官方服务 | 图床 `upload` 权限 API Token，只允许官方 Broker Worker 读取 |
| `NQ_IMGBED_CHANNEL_NAME` | 仅官方服务可选 | 多同类渠道时的固定渠道名 |
| `NQ_IMGBED_ENCRYPTION_KEY` | 仅旧部署兼容 | 解密旧版 D1 图床 Token 的专用密钥 |
| `NQ_PUBLIC_BROKER_ENABLED` | 仅官方服务 | 只在维护者生产 Worker 开启公益上传端点，普通部署不要设置 |

写入与查看：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler secret list
```

`NQ_IMGBED_*` 只在设置 `NQ_PUBLIC_BROKER_ENABLED=true` 的官方 Worker 生效。普通部署的 NQ 图片链路固定在代码中，不能通过变量、图床地址或 Token 覆盖，也看不到共享 Token。

## 认证与告警 vars

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 新部署必填 | 后台账号；旧部署未配置时回退 `admin` |
| `ADMIN_PATH` | `/admin` | 一键部署必填；登录后可在后台写入 D1 覆盖 |
| `APP_UPDATE_MANIFEST_URL` | 官方公开清单 | 覆盖后台检查应用更新时读取的 HTTPS 版本清单 |
| `GITHUB_OAUTH_CLIENT_ID` | 空 | GitHub OAuth Client ID |
| `GITHUB_OAUTH_ALLOWED_USERS` | 空 | GitHub 用户名白名单，英文逗号分隔 |
| `GITHUB_OAUTH_CALLBACK_ORIGIN` | 当前 API Origin | 固定 OAuth callback 的 HTTPS Origin |
| `ALERT_EMAIL_FROM` | 空 | Resend 发件人 |
| `ALERT_EMAIL_TO` | 空 | 收件人，英文逗号分隔 |
| `ALERT_EMAIL_REPLY_TO` | 空 | 可选 Reply-To |

GitHub 登录必须同时配置 Client ID、Client Secret 与非空白名单，否则按钮不显示。授权完成后按 `PUBLIC_SITE_ORIGIN` 返回管理页。

## Agent 环境变量

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `NSTATUS_API_BASE` | 无 | 必填 HTTPS API |
| `NSTATUS_AGENT_TOKEN` | 无 | 必填 scoped Token |
| `NSTATUS_AGENT_ID` | 主机名 | 目标 ID |
| `NSTATUS_AGENT_LABEL` | 主机名 | 展示名 |
| `NSTATUS_SAMPLE_SEC` | `1` | 本地采样秒数 |
| `NSTATUS_INTERVAL_SEC` | `300` | 上报秒数 |
| `NSTATUS_PING_SEC` | `20` | Ping 秒数 |
| `NSTATUS_PING_TARGET_REFRESH_SEC` | `600` | Ping 目标配置刷新秒数，限 60–3600 |
| `NSTATUS_PING_TARGETS` | `*` | 后台受管目标 |
| `NSTATUS_QUEUE_FILE` | 平台路径 | 队列文件 |
| `NSTATUS_QUEUE_MAX_SAMPLES` | `86400` | 队列上限 |
| `NSTATUS_UPDATE_CHECK_SEC` | `3600` | 更新检查秒数，限 900–86400 |
| `NSTATUS_ALLOW_INSECURE_HTTP` | 未启用 | 仅可信私网调试 |

## 修改配置

- vars 修改后重新部署 Worker。
- secrets 修改后更新 secret binding。
- 后台设置写 D1，不需要重新部署。
- Agent env 修改后重启服务。
- 缩短采样/上报间隔会增加 CPU、网络与存储压力。
- 修改时区改变每日桶边界，不建议上线后频繁修改。
