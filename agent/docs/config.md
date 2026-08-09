# 配置参考

完整配置见 `docs/zh-CN/07-configuration.md` 与 `docs/en/07-configuration.md`。

## Worker

一键部署创建 Worker、D1、R2、Durable Objects 与 Cron 绑定。首次部署必填 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_PATH`、`TOTP_ENCRYPTION_KEY`。可选配置覆盖站点名称、时区、探测并发、缓存 TTL、历史保留窗口、告警上限与 Agent 更新参数。Secret 一律通过 Wrangler Secrets 设置，不进入 `wrangler.toml` 或前端源码。

`NQ_PUBLIC_BROKER_ENABLED` 只用于标记官方维护实例；普通部署不设置，使用公开的公益 NQ 图片 Broker。

## Agent 环境变量

见 `agent/README_zh.md` 的环境变量表。核心项：`NSTATUS_API_BASE`、`NSTATUS_AGENT_TOKEN`、`NSTATUS_AGENT_ID`、`NSTATUS_SAMPLE_SEC`、`NSTATUS_INTERVAL_SEC`、`NSTATUS_PING_SEC`。`NSTATUS_ALLOW_INSECURE_HTTP=1` 只用于可信私网调试。
