# API

## 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康状态 |
| GET | `/api/status` | 目标、状态、摘要、公开 Agent 指标与解锁结果 |
| GET | `/api/checks?target_id=...` | 单目标 Cloudflare 检查历史 |
| GET | `/api/agent/metrics?agent_id=...` | 公开 Agent 指标 |
| GET | `/api/agent/pings?agent_id=...` | Agent TCP Ping |
| GET | `/api/latency?target_id=...` | 外部 Latency Agent 历史 |
| GET | `/api/v1` | 版本化只读开发接口清单 |
| GET | `/api/themes` | 当前启用主题的公开清单 |
| GET | `/api/themes/file/:id/@:revision/*` | 当前启用主题的版本化包内资源 |

`/api/v1` 及 `/api/v1/*` 是稳定只读线，供第三方前端使用。替代前端只能通过父页面代理访问主题白名单资源；插件与任意扩展上传不开放。

旧版手工粘贴的 NodeQuality 报告接口保持只读兼容；Beta NQ 任务直接保存 Agent 采集的结构化结果，Worker 只上传本地渲染的 SVG，公开报告中的图片地址固定为本站代理。

## Agent 接口

使用每节点独立 Bearer Token：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/metrics` | 上报指标 |
| GET | `/api/agent/ping-targets` | 获取 Ping 配置 |
| POST | `/api/agent/pings` | 上报 Ping |
| GET | `/api/agent/config` | 获取 GeoIP 配置 |
| POST | `/api/agent/location` | 上报 IPv4/IPv6 位置 |
| GET | `/api/agent/tasks` | 领取固定 Beta 动作 |
| POST | `/api/agent/tasks/:id` | 上报固定动作结果 |
| GET | `/api/agent/update-policy` | 获取更新策略 |

任务接口只返回 `nodequality` 或 `ip_unlock` 动作枚举，不返回脚本文本、参数或任意 stdin。

## 管理接口

需要有效 `x-admin-session`：目标、Ping、Latency Agent 与排序；Agent 安装命令与凭据轮换；GeoIP 设置；固定任务创建/列表/取消；Telegram、邮件与规则；外观、后台路径与更新；备份导出、预览与恢复；主题列表、上传、启用、停用与删除。

账号密码只发送到登录端点，不作为通用 API Token 使用。

## 限制

公共历史接口限制时间范围与采样点数量，裁剪敏感字段，并按隐私设置掩码地址或端口。第三方前端应处理 `429`、缓存头与字段缺失，不依赖内部表结构。
