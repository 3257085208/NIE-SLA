# API 参考

当前 API 的完整文档在仓库根 `docs/zh-CN/08-api.md` 与 `docs/en/08-api.md`。这里只列路由分类。

## 公开只读

`/api/health`、`/api/status`、`/api/checks`、`/api/agent/metrics`、`/api/agent/pings`、`/api/latency`、`/api/themes`、`/api/nq/:id`、`/api/nq/:id/image/:tab`。

`/api/v1` 及 `/api/v1/*` 是版本化只读接口，供替代前端与第三方集成使用。

## 管理接口

需要 `POST /api/auth/login` 取得的 `x-admin-session`（启用 TOTP 时叠加验证码）。覆盖目标、节点凭据、GeoIP、固定任务、告警、外观、更新、备份恢复、安全与加密、主题、调试日志。

## Agent 接口

使用每节点 scoped Bearer Token。包括 metrics、pings、ping-targets、config、location、update-policy、tasks 的领取与结果回传。

`/api/agent/targets` 与 `/api/agent/results` 是旧端点，只保留给已弃用的 Python 外部 Agent。
