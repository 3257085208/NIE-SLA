# 安全与免费额度

## 凭据与认证

- 后台使用账号密码与短期 Session，可选 GitHub OAuth（必须配置精确 callback 与用户名白名单）与 TOTP。
- 每台 Agent 使用独立 scoped Token；安装票据一次性有效，兑换后即失效。
- Agent 只主动访问 Worker，不监听远程管理端口。
- 公共接口裁剪秘密字段，并按设置掩码 IP/端口。
- 每节点 Token 即使泄露也不具备后台管理权限。

## 固定动作边界

Beta 动作需要 root 权限，因此与主遥测服务分离。Manager 只接受 Worker 返回且本地二进制同样支持的动作枚举；管理员不能提交 Shell 文本、URL、参数、stdin、环境或计划。脚本子进程会清空 Agent 环境，并限制下载大小、超时与输出。

NodeQuality 与 IP.Check.Place 动作会下载并执行对应服务当前提供的脚本及其依赖，这是两个 Beta 功能明确保留的外部信任边界。只应在认可相应提供方时手动触发；关闭或不触发不影响监控。

Agent 更新的 manifest 哈希由同一 Worker 策略提供，能防止传输损坏与错误文件，但不能替代独立离线发布签名。Worker 或发布环境失陷仍属于运维风险。

## 主题与扩展

- 第三方 CSS 主题不执行脚本；Canvas 主题在无同源权限的沙箱中运行，只能通过 `status:read` 白名单桥接。
- 主题 ZIP 有大小、文件数、路径、类型、Manifest 与 SHA-256 校验，上传后默认停用。
- 插件、后台脚本、市场导入与任意扩展执行不开放。
- 自定义 GeoIP URL 只允许公开 HTTPS，拒绝显式本机、内网与云元数据地址。

## 备份

普通备份不含凭据。敏感备份密码至少 10 位，文件与密码分开保存。恢复前自动写 R2 快照，但快照不能替代离线备份。

## 免费额度

> **当前估算规则：** 当前规划统一使用版本化的[站点用量模型](../usage-model.md)
> 和 [`../../scripts/usage-model-calibration.json`](../../scripts/usage-model-calibration.json)。
> 下方的 100 台 VPS 表格是历史架构情景，不是线上实时读数，也不是 Cloudflare
> Dashboard 数值保证。

实际额度取决于 VPS 数量、公开访问量、Ping 数量、重试、历史范围与告警。默认设计：

- Cron 每分钟更新当前状态；Agent 仍按 5 分钟上传。
- D1 使用 5 分钟 SLA 桶；30 天汇总优先读 R2 增量日统计。
- 高频 Metrics/Ping 先进每 Agent 隔离的 Durable Object，按小时合并写 R2。
- 流量页面合并未落盘差值；周期账本最多每 30 分钟落盘一次。
- 凭据活跃时间最多每 6 小时写一次；状态快照每 5 分钟写一次 R2。
- 公共接口限制历史范围与最大采样点。

按 100 台 VPS、全部开启流量统计、2 个 External Latency Agent、每 5 分钟上报、当前状态每分钟刷新估算（不含静态资源访问）：

| 资源 | 估算 | 免费上限 | 余量 |
| --- | ---: | ---: | ---: |
| Workers 动态请求 | 约 86,448 次/天 | 100,000 次/天 | 约 13,552 次/天供页面与 API |
| Durable Objects 请求 | 至少约 28,800 次/天 | 100,000 次/天 | 典型配置仍有余量，需 Dashboard 实测 |
| D1 写入行 | 约 95,376 行/天 | 100,000 行/天 | 约 4,624 行/天 |
| D1 读取行 | 约 100–250 万行/天 | 5,000,000 行/天 | 视访问量变化 |
| R2 Class A | 约 210,240 次/月 | 1,000,000 次/月 | 约 789,760 次/月 |

官方口径（以官方页面为准）：Workers Free 动态请求 100,000/天、每次 10 ms CPU；D1 Free 每天 5,000,000 行读取、100,000 行写入、账户总存储 5 GB；Durable Objects Free 请求 100,000/天、SQLite 总存储 5 GB；R2 Standard 免费 10 GB-month、Class A 1,000,000/月、Class B 10,000,000/月。Workers Static Assets 请求免费且不限量，但命中 Worker 的动态页面/API 请求仍计入 Workers 请求。

结论：默认配置可把 100 台 + 5 分钟上报控制在免费额度理论范围内，D1 写入是最紧的指标；大量后台操作、异常重试、通知状态变化、超过 2 个 Latency Agent 或修改默认间隔都会占用余量。200 台/10 分钟上报会超出免费额度。上线后在 Dashboard 对 Workers、Durable Objects、D1 rows written/read、R2 Class A/B 设置告警；任一指标长期接近 80% 时，降低上报频率、减少重试或切换 Workers Paid。

官方依据：

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
