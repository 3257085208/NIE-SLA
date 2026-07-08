# 07 配置参考

## Worker vars

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PUBLIC_SITE_NAME` | `NStatus` | 站点名称 |
| `PUBLIC_WORKER_URL` | 空 | Worker 公网 URL |
| `PUBLIC_AGENT_INSTALL_BASE` | 自动 | 安装脚本/二进制下载根地址 |
| `ALLOWED_ORIGIN` | 空 | 前端跨域 Origin |
| `TIMEZONE_OFFSET_MINUTES` | `480` | 时区偏移 |
| `CONCURRENCY` | `8` | 探测并发 |
| `MAX_TARGETS_PER_RUN` | `60` | 每轮最多探测目标数 |
| `STATUS_CACHE_TTL` | `45` | 状态 API 缓存秒数 |
| `AGENT_METRICS_TO_D1` | `false` | 是否将高频指标写 D1 |
| `AGENT_PINGS_TO_D1` | `false` | 是否将 Ping 历史写 D1 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 高频历史保留小时 |
| `RATE_LIMIT_D1` | `true` | D1 持久限速 |
| `TELEGRAM_CHAT_ID` | 空 | 可选 TG Chat ID |

## Worker secrets

| Secret | 说明 |
| --- | --- |
| `ADMIN_TOKEN` | 后台登录 |
| `AGENT_TOKEN` | Agent 上报 |
| `TOTP_ENCRYPTION_KEY` | TOTP 加密密钥 |
| `TELEGRAM_BOT_TOKEN` | 可选 TG Bot Token |
| `ALERT_ENCRYPTION_KEY` | 可选 TG Token D1 加密密钥；未设置时复用 `TOTP_ENCRYPTION_KEY` |

## Agent 环境变量

| 变量 | 说明 |
| --- | --- |
| `NSTATUS_API_BASE` | Worker API 地址 |
| `NSTATUS_AGENT_TOKEN` | Agent Token |
| `NSTATUS_AGENT_ID` | 后台目标 ID |
| `NSTATUS_AGENT_LABEL` | 显示名称 |
| `NSTATUS_INTERVAL_SEC` | 上报间隔 |
| `NSTATUS_SAMPLE_SEC` | 本地采样间隔 |
| `NSTATUS_PING_SEC` | Ping 间隔 |
| `NSTATUS_PING_TARGETS` | Ping 目标 ID 或 `*` |
