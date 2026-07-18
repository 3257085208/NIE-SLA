# 07 配置与环境变量参考

配置分为 Worker vars、Worker secrets、后台 D1 设置和 Agent 环境变量。不要把 secret 放入 `[vars]`。

## Worker 核心 vars

| 名称 | 推荐/默认 | 说明 |
| --- | --- | --- |
| `PUBLIC_SITE_NAME` | `NIE-SLA` | 公开站点名称，可自定义 |
| `PUBLIC_WORKER_URL` | Worker HTTPS URL | 区域/安装地址回退 |
| `TIMEZONE_OFFSET_MINUTES` | `480` | UTC+8，影响每日桶和归档 |
| `CONCURRENCY` | `40` | 单轮并发目标数 |
| `MAX_TARGETS_PER_RUN` | `60` | 单轮最大目标数 |
| `CHECKS_DEFAULT_LIMIT` | `864` | 明细默认上限 |
| `CHECKS_WINDOW_HOURS` | `72` | 明细默认窗口 |
| `PUBLIC_MASK_IPS` | `true` | 公开接口掩码 IP |
| `PUBLIC_HIDE_PORTS` | 按需 | 公开接口隐藏端口 |
| `INCIDENTS_TO_D1` | `true` | 事件写 D1 |
| `RATE_LIMIT_D1` | `true` | 使用 D1 做跨实例限流 |
| `MISSED_WRITE_BACKFILL_MAX_BUCKETS` | `6` | 最多补写漏检桶 |
| `ALERT_MAX_MESSAGES_PER_RUN` | `30` | 单轮报警上限 |

## 指标与历史

| 名称 | 推荐/默认 | 说明 |
| --- | --- | --- |
| `AGENT_OFFLINE_AFTER_SEC` | `900` | Agent 离线阈值，代码限制 120–3600 |
| `AGENT_METRICS_RETENTION_HOURS` | `6` | D1 临时指标保留 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 高频历史保留 |
| `AGENT_METRICS_POINTS_PER_REPORT` | `6` | 报告抽样点控制 |
| `AGENT_METRICS_TO_D1` | `false` | 是否将高频指标写 D1 |
| `AGENT_PINGS_TO_D1` | `false` | 是否将 Ping 高频历史写 D1 |
| `PING_HISTORY_RETENTION_HOURS` | `6` | D1 Ping 临时历史 |

高频写 D1 会显著增加写入量，除非明确评估额度，不要轻易设为 `true`。

## 安装与更新 vars

| 名称 | 说明 |
| --- | --- |
| `PUBLIC_AGENT_INSTALL_BASE` | 安装脚本和 `bin/` 的公开 HTTPS Base |
| `PUBLIC_AGENT_API_BASE` | Agent 上报 API Base |
| `AGENT_DOWNLOAD_BASE` | 自动更新读取 `VERSION`/`SHA256SUMS` 的 HTTPS Base，通常与 Pages 相同 |
| `AGENT_LATEST_VERSION` | Worker 返回的最新版本，例如 `v1.0.14` |
| `NSTATUS_SHA256SUMS_SHA256` | 发布 manifest 自身 SHA-256 |
| `AGENT_AUTO_UPDATE_DEFAULT` | 后台无设置时默认策略 |
| `AGENT_UPDATE_CHECK_SEC` | Agent 策略检查建议间隔 |
| `AGENT_PING_SEC` | 安装命令默认 Ping 间隔 |

## Worker secrets

| 名称 | 必需 | 用途 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 是 | 后台认证 |
| `AGENT_TOKEN` | 是 | 派生 scoped Token |
| `TOTP_ENCRYPTION_KEY` | 启用 TOTP 时 | 加密 TOTP secret |
| `ALERT_ENCRYPTION_KEY` | 后台保存 TG Token 时 | 加密报警 secret |
| `TELEGRAM_BOT_TOKEN` | 可选 | 环境配置 TG Bot |
| `TELEGRAM_CHAT_ID` | 可选 | 环境配置 Chat ID |

写入：

```bash
npx wrangler secret put ADMIN_TOKEN --config wrangler.local.toml
```

列出 secret 名称不会显示值：

```bash
npx wrangler secret list --config wrangler.local.toml
```

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
| `NSTATUS_PING_TARGET_REFRESH_SEC` | `600` | 后台 Ping 目标配置刷新秒数（限制 60–3600） |
| `NSTATUS_PING_TARGETS` | `*` | 后台受管目标 |
| `NSTATUS_QUEUE_FILE` | 平台路径 | 队列文件 |
| `NSTATUS_QUEUE_MAX_SAMPLES` | 程序默认 | 队列上限 |
| `NSTATUS_UPDATE_CHECK_SEC` | 程序默认 | 更新检查秒数 |
| `NSTATUS_ALLOW_INSECURE_HTTP` | 未启用 | 仅可信私网调试 |

## 修改配置的原则

- vars 修改后必须重新部署 Worker。
- secrets 修改通常产生新 Worker 版本或更新 secret binding。
- 后台设置写 D1，不需要重新部署。
- Agent env 修改后需要重启服务。
- 缩短采样/上传间隔会增加 CPU、网络和存储压力。
- 修改时区会改变每日桶边界，不建议上线后频繁修改。
