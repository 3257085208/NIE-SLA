# 09 运维与故障排查

本章按“先判断是哪条链路，再定位具体组件”的顺序排障。

## 日常健康检查

每天或每次发布后检查：

```bash
curl -fsSL https://YOUR-API/api/health
curl -fsSL https://YOUR-PAGES/bin/VERSION
curl -fsSL https://YOUR-PAGES/bin/SHA256SUMS
```

Cloudflare：

```bash
npx wrangler deployments list
npx wrangler pages deployment list --project-name YOUR_PROJECT
```

数据库 Cron 诊断：

```bash
npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT key,value,updated_at FROM app_meta WHERE key IN ('scheduled:probe:last','scheduled:last');"
```

`scheduled:probe:last` 应包含目标总数、耗时和失败数。`count` 等于启用目标数，表示所有目标都进入本轮；`failed` 可能是真实连接失败，不等于漏检。

## 排障总览

| 现象 | 首查 |
| --- | --- |
| 整站打不开 | Pages Deployment、DNS、浏览器 Network |
| API 404/5xx | Worker Version、routes、D1/R2 binding |
| 多目标同一时间漏检 | Cron 诊断、并发、执行耗时 |
| 单目标持续失败 | 目标地址、端口、区域、网络 |
| Agent 离线 | Agent 服务、日志、Token、API DNS |
| Agent 在线但 CF 红 | CF 入站链路，IPv6/AAAA/防火墙 |
| Latency 节点“尚未上报” | 外部 Latency 服务、首次 `--once` 输出、节点 Token |
| 前端 Latency 只有 Cloudflare | `latency_results`、stale 窗口、目标是否为公开 TCP |
| 图表点少 | 采样、上传批次、R2、窗口和抽样 |
| 登录后跳回登录页 | TOTP session、时间、缓存、401 |
| 429 | D1 限流窗口，不要继续重试 |

## Cron 漏检

真实漏检通常表现为同一时间多个目标没有探测结果，之后被系统补为 missed bucket。

检查：

1. `scheduled:probe:last.count` 是否等于启用目标数。
2. `duration_ms` 是否接近 Worker 生命周期或超时上限。
3. 目标数量是否超过 `MAX_TARGETS_PER_RUN`。
4. `CONCURRENCY` 是否仍是旧值 8。
5. 是否在每分钟 Cron 中执行大量 R2/D1 清理。

当前推荐 `CONCURRENCY=40`，维护任务每小时执行。不要把真实失败的 `ok=0` 当成漏检；只有 `missed=true`/synthetic 记录才是调度缺口。

## Agent 在线但 CF Latency 为 `-`

Agent 和 CF 是相反方向。按顺序：

1. 确认目标端口正在公网监听。
2. 从另一条网络连接该端口。
3. 检查安全组、IPv4/IPv6 防火墙。
4. IPv6 直接地址改为 DNS-only AAAA。
5. 确认域名没有橙云。
6. 查看具体错误是 timeout、refused 还是 disallowed。

详见 [12 IPv6 教程](12-ipv6-cloudflare-probe.md)。

## Agent 没有上报

Linux：

```bash
sudo cftz status
sudo cftz log 200
sudo systemctl restart nstatus-metrics
```

检查环境文件存在且权限正确，不要在终端打印 Token：

```bash
sudo test -r /opt/nstatus-metrics/nstatus-metrics.env
sudo stat /opt/nstatus-metrics/nstatus-metrics.env
```

常见原因：

- API Base 指向 Pages/Worker 错误域名。
- IPv6-only 机器无法解析/访问只有 A 记录的域名。
- scoped Token 与 Agent ID 不匹配。
- 系统时间偏差导致 TLS/TOTP/时间窗口异常。
- 服务启动的是旧二进制或重复进程。

## 外部 Latency Agent 没有上报

外部 Latency Agent 与普通 Rust Agent 是两个独立服务。后台已有节点但“最近上报”为“尚未上报”，表示 D1 中只有节点记录，尚无一次成功结果。

在测量节点检查：

```bash
sudo systemctl is-active nstatus-latency-agent.service
sudo journalctl -u nstatus-latency-agent.service -n 100 --no-pager
sudo sh -c 'set -a; . /etc/nstatus-latency-agent.env; set +a; /usr/bin/python3 /opt/nstatus-latency/latency-agent.py --once'
```

成功输出应包含 `targets` 和大于 0 的 `accepted`。旧脚本可能因 Python 默认 User-Agent 被 Cloudflare 1010 拦截，应在后台重新生成当前部署命令并完整重装，不要只重启旧服务。

若后台已经显示最近上报，但前端仍只有 Cloudflare，等待几十秒状态缓存刷新，并确认查看的目标是公开 TCP 目标。完整说明见 [13 外部 Latency Agent 部署与排障](13-external-latency-agents.md)。

## Agent 版本没有更新

```bash
/opt/nstatus-metrics/nstatus-metrics --version
curl -fsSL https://YOUR-PAGES/bin/VERSION
sudo cftz update
```

若自动更新开启但没有立即更新，等待策略检查周期。多台 VPS 会滚动更新，不保证同一秒完成。

## 高频指标点很少

依次确认：

1. Agent 日志显示每秒采样。
2. 上报请求包含批量 points，而不是只有 latest。
3. R2 小时对象持续增加。
4. `AGENT_METRICS_R2_RETENTION_HOURS` 足够覆盖查询窗口。
5. 前端请求的 hours/limit 没有过小。
6. 图表抽样没有被误认为原始数据丢失。

本地 1 秒精度不表示 API 必须返回一小时 3600 个未经抽样的点。

## 红色日色块

日色块使用 CF daily summary。修复地址后历史不会被重写。当天颜色根据新旧成功点的比例逐步变化：

```text
uptime_pct = ok_count / total * 100
```

需要验证修复是否生效，应看最新 5 分钟明细，不要只看 30 天色块。

## 后台登录循环

1. 强制刷新，确认 Pages 已部署匹配的 `admin.html` 与 `js/admin.js`。
2. 浏览器 Console 检查模块 404。
3. Network 查看 `/api/login` 和 `/api/totp/verify` 状态码。
4. 401：Token/TOTP/session 问题。
5. 429：等待限流窗口。
6. 校准手机验证器和电脑时间。
7. 清理该站点 sessionStorage 后重新登录。

不要通过关闭所有限流解决登录问题。

## Telegram 不报警

- 先在后台保存并发送测试消息。
- 检查 Bot Token、Chat ID、Bot 是否在群组中。
- 检查报警总开关和单目标开关。
- 指标阈值填 0 表示关闭该项。
- 离线阈值未达到时不会报警。
- 同一规则受 repeat cooldown 限制。
- 手动“立即检查”查看返回 sent/errors。

## 流量一直为 0

- 在单台 VPS 编辑窗口开启流量统计。
- 检查 Agent 是否上报累计 rx/tx 计数。
- 确认网卡重启/计数回绕处理。
- 检查当前计费周期起止日期。
- 流量模式可能是仅上行/仅下行，不要只看另一方向。

## Pages 已推送但没上线

```bash
npx wrangler pages deployment list --project-name YOUR_PROJECT
```

核对 Source commit。Git 自动构建排队时可以从干净工作区直接部署：

```bash
npx wrangler pages deploy . --project-name YOUR_PROJECT --branch main
```

然后通过生产域名请求具体静态文件，并用随机查询参数绕过浏览器缓存。

## D1 维护

- 不要在高峰 Cron 前执行大范围 DELETE。
- 清理任务按小时运行。
- 变更 schema 前导出。
- 远程命令明确加 `--remote`，避免误查本地空数据库。
- 检查数据库大小和表行数，不要只看 Worker 请求量。

## 收集故障信息

报告问题时提供：

- 时间和时区。
- Worker Version ID、Pages Deployment ID、Agent 版本。
- 受影响目标数量。
- `/api/health` 状态码。
- 去除 Token/IP 后的错误文本。
- 最近 Cron 诊断。
- Agent 日志相关 50–200 行。

绝不要提供完整安装命令、管理员密码/Session、Agent Token、TOTP secret、Telegram Bot Token 或 Resend API Key。
