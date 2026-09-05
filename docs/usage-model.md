# NIE-SLA 站点用量估算模型 v1.3.3

## 目的

`usage-model-v1.3.3` 是 NIE-SLA 的固定用量估算方法。它的**观测输入**只来自
`sla.example.com` 的公开状态接口，以及在提供管理员会话时的站点
`/api/debug/usage-summary` 聚合接口；固定计算系数来自仓库内版本化的 calibration 文件。运行时不会访问
Cloudflare Dashboard、Cloudflare API 或浏览器会话。当前系数用一组同拓扑的人工
Cloudflare 24 小时对账数据校准，并明确保存在 calibration 文件中；这不是运行时读取 CF。

模型输出 Workers Functions 调用、R2 Class A/B 操作与请求分布、D1 查询和读取/写入行数，
并把每一项拆成：

- `observed`：完整站点日志窗口内直接数出的请求；
- `observed+derived`：日志不完整时，把已观测数量作为下界，再用周期补齐；
- `derived`：依据当前源码中的固定周期、目标数量和 Agent 版本推导；
- `assumption`：站点目前没有记录、只能用版本化先验估算的公开流量、WSS 重连等。

每个指标同时输出 `estimate`、`low`、`high`。默认 `range_mode=operational`，区间是
围绕点估计的稳定运营对账范围；它不再把多个独立的最坏情况相乘，因此适合和 CF
的 24 小时页面直接比较。需要评估旧 Agent、WSS fallback、缓存失效或大量重试时，
显式使用 `--range-mode stress` 查看压力上界。两种模式都不是 CF 的实际账单数，
`observability.confidence` 仍然用于判断输入证据是否足够。

## 固定输入边界

### 1. 公共状态快照

没有 `--status-file` 时，脚本读取：

```text
https://status.example.com/api/status?fresh=1&days=1&lite=1
```

快照提供目标数量、TCP/HTTP 类型、Agent 版本与在线状态、外部 Latency 节点、
Ping 目标、流量开关和当前时间。脚本用快照里的 `now` 作为窗口结束时间，默认取
前 24 个小时，并且始终按 UTC 计算，以便和 CF 的滚动 24 小时窗口对照。

### 2. 站点 debug 日志

设置只读凭据后，脚本只读取站点的：

```text
/api/debug/usage-summary?from=<unix-sec>&to=<unix-sec>&hours=24
```

`NIE_SLA_ADMIN_SESSION` 必须是原始的短期 `x-admin-session` **值**（可选地带
`x-admin-session:` 前缀），不是 Cookie、Bearer/Basic 值或完整 HTTP 头集合。脚本只会把
它发送到受信任 HTTPS 站点的 `x-admin-session` 请求头；它不会读取、导出或自动桥接浏览器
`sessionStorage`。该会话当前默认 24 小时到期，操作者必须以受控方式临时提供给当前 shell。

这是管理员会话保护的低成本摘要：服务端最多接受 24 小时窗口，只做一次基于
`idx_debug_logs_ts` 的有界 `GROUP BY route, method, status`，最多返回 512 个聚合组，
不返回原始日志、IP、actor、目标/任务 ID、summary 或 ref，也不把这次读取写回
`debug_logs`。响应中的 `query` 字段会标明聚合语句数、返回的聚合组数、时间索引和
是否截断。重复查看使用 30 秒短时私有缓存，并有每个 isolate 每 5 分钟最多 6 次的
内存限流；它仍会执行已有的
管理员会话验证和必要的 schema 初始化，这些固定开销不应被 `query.statements=1`
误读为整个 HTTP 请求绝对只产生一条 D1 操作。

旧 `/api/debug/logs` 仍保留用于后台兼容和人工查看少量详情，但它会返回原始行并
额外执行 `COUNT(*)`，禁止再用于模型的循环分页或大窗口抓取。

当前 Worker 的 debug 记录只覆盖选定的 Agent、Latency、后台任务路由，并不覆盖所有
公开 `status/detail` 请求，也不记录 WSS Durable Object 的完整建连/重连生命周期。
因此聚合摘要可以直接校准已记录路由，却不能单独恢复完整 CF 账单；不完整或被截断时
脚本必须继续输出 `logs_complete:false`。

完整日志会直接覆盖这些路由的周期推导：Agent 任务轮询、更新策略、配置/位置、
Latency 更新策略、后台任务列表以及其他已记录 API。部分日志只作为下界。

### 3. 本地校准文件

`scripts/usage-model-calibration.json` 保存 v1.3.3 的透明先验和输出区间。它不包含凭据，
只记录脱敏的成对数量和校准规则。先验来自当前 Worker/Rust 源码路径、Cloudflare 官方
指标定义和同拓扑成对观测；运行时仍然只读站点数据。若以后有新的稳定窗口，可以在本地离线拟合输出乘数，
但不要把 Cookie、Token、截图原件或账号信息放进仓库。

## 计算方法

### Workers Functions

模型按以下组件建立账本：

1. WSS Agent 遥测消息只进入 Durable Object，不把每条消息误算成 HTTP Function 调用；
   当前指标状态也写入 Agent 专属 TelemetryBuffer Durable Object，正常路径不再写
   `agent_metrics_state`，因此 D1 账本只保留它的读取/兼容回退路径。
2. 低于 WSS 能力版本或明确走 HTTP 的 Agent，按报告周期计 HTTP 遥测；WSS fallback
   只放入上界，避免把稳定 WSS 的消息全部重复计费。
3. Agent Manager 任务轮询默认每 600 秒，更新策略检查默认每 900 秒；若完整站点日志
   可用，则用日志直接计数。
4. Agent 配置读取和位置回传按天估算；旧 Agent 的 Ping 目标刷新按 1,800 秒估算。
5. 每个外部 Latency 节点按 60 秒分别计目标列表读取、结果提交；更新策略按 3,600
   秒计数。
6. Cron 调度入口按每分钟计数。
7. 公开动态请求用 `workers_public_rps` 先验计数，当前点值为 0.42 req/s，来自同拓扑
   对账而不是原先的 0.3。静态 Pages Asset 请求不计入 Workers Functions；可用
   `--public-rps` 暂时覆盖点估计。
8. WSS 建连/重连用每个可用 WSS Agent 每天的版本化先验计入；因为站点当前没有
   WSS 生命周期日志，这一项会明确标为 `assumption`。

因此 Workers 的基本结构是：

```text
Functions = 可观测/周期 API 请求
          + 公开动态请求（秒数 × public_rps）
          + WSS 建连/重连先验
```

这里的 Workers 数字对应 Cloudflare 的 Worker incoming requests；Cloudflare 将
`fetch()` 产生的 subrequests 单独统计，静态 Asset 请求也不应混入这个数字。官方定义见
[Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)。

### R2

R2 账本按源码中的对象路径计算：Latency 结果段读改写、Agent 遥测按小时落盘、
探测状态合并、状态快照、跨日历史归档和公开请求引起的读取。WSS 每条消息不直接
产生 R2 操作。

先用校准文件中的透明因子计算点估计。默认运营模式再用每项指标的
`output_multipliers` 围绕点估计套一个固定的运营区间；这一步不会把内部每个因素的
低值和高值继续相乘。压力模式使用 `stress_factors` 和原来的组合式范围，保留
异常情形的保守上界：

```text
Class A = 基础 Class A × r2_class_a_multiplier
Class B = 基础 Class B
请求分布 = (Class A + Class B) × r2_distribution_over_ab
```

这里的“请求分布”是 CF R2 指标的独立展示口径，不应把它当成 Class A + Class B
的恒等式。`r2_public_read_rate` 只作用于无法从站点日志直接获得的公开读取；当前值下调
是因为公开 Worker 请求大部分可以命中缓存，不会一一触发 R2。Class A/B 的区别见
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)。

### D1

D1 先按每类请求的源码 SQL 路径建立 profile：读取查询、写入查询、扫描行数和
实际写入行数分别累计。Agent 凭据的认证查询和 `last_used_at` 真正受影响的行
分开计算，避免把每次认证查询都错误地当成一次写入。

D1 最终输出四个独立量：

```text
查询总数 = (读取查询 + 写入查询) × d1_query_path_multiplier
已读取行 = 基础扫描行 × d1_rows_read_multiplier
已写入行 = 基础受影响行 × d1_rows_written_multiplier
```

Cloudflare 的 `rowsRead` 是实际扫描/读取的行数，包含索引访问，不是返回结果的行数；
`rowsWritten` 也按实际受影响的行计。这解释了为什么 D1 “查询总数”不能从“已读取行”
反推，也不能把一次批量 SQL 简单等同为一行。官方口径见
[D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
和 [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)。

v1.3 的正常写入边界是：Agent 上报的当前指标状态由 TelemetryBuffer Durable Object
保存并由 fleet 状态索引提供后台读取；探测的当前状态由 R2 `state/status.json`
保存，D1 只更新调度用的 `targets.next_probe_at`。因此正常路径每次 WSS 上报少一行
`agent_metrics_state`，每次探测少一行 `latest_status`。R2/DO 写入失败时仍会按原
兼容路径回退到 D1，以保证页面和调度不丢数据；这类异常回退不应被模型点估计隐藏，
需要在对账窗口中单独记录。

v1.3.3 新增 Durable Object（DO）请求台账：v1.3 把高频当前状态写入从 D1 迁移到 DO
之后，DO 自有的账户级请求限额（免费层 100k 请求/日；DO 内部 SQLite 存储操作不计入
请求配额）成为新的余量观测点。模型现在在输出的 `do` 字段给出四类 DO 请求的点估计与
区间：TelemetryBuffer 的 WSS 消息唤醒（Hibernation 下每条入站消息计一次）、
ProbeHistoryBuffer 探测追加、ProbeRegion 定时调度执行（仅配置 REGION_PROXY 时，
可用 `--no-region-proxy` 关闭）与 StatusStream 事件发布。Hibernation 下 DO 时长
为毫秒级活跃处理，13k GB-s/日 的时长限额当前规模可忽略。DO 台账尚无实测校准，
按源码路径直接推导。

## 使用命令

在当前机器上使用配置好的 bundled Node：

```bash
cd /Users/marknkx/Desktop/NIE-SLA/agent
/Users/marknkx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/usage-model.mjs --hours 24 --range-mode operational
```

压力检查：

```bash
/Users/marknkx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/usage-model.mjs --hours 24 --range-mode stress
```

输出 JSON 便于保存为本地、脱敏的观测记录：

```bash
/Users/marknkx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/usage-model.mjs --hours 24 --json
```

如果要纳入站点 debug 日志，优先在后台“设置 → 安全”中生成一次性显示的“用量模型只读凭据”。
它是 24 小时有效、最多同时 3 个、只能读取本汇总接口的 `nsu_` 凭据；不能登录后台、不能读取
原始调试日志、不能修改任何配置，可随时一键全部撤销。不要把真实值写进命令历史、参数、日志或
Git。这个命令不会访问浏览器 Cookie/`sessionStorage`，也不会把浏览器已登录状态自动转移给终端：

```bash
read -s NIE_SLA_USAGE_TOKEN
export NIE_SLA_USAGE_TOKEN
/Users/marknkx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/usage-model.mjs --base-url https://status.example.com --hours 24
unset NIE_SLA_USAGE_TOKEN
```

如果尚未部署支持只读凭据的 Worker，`NIE_SLA_ADMIN_SESSION` 仍是兼容性后备：它必须是原始
`x-admin-session` 值，且具有完整后台权限，因此不建议写入终端环境。脚本会拒绝把任一凭据发送到
非 HTTPS、非受信任域名或非标准生产端口，拒绝跟随重定向，并且不会在输出中打印凭据值。也可以用
脱敏后的本地日志文件复现：

```bash
/Users/marknkx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/usage-model.mjs --status-file /tmp/status.json --logs-file /tmp/logs.json \
  --from 2026-09-01T00:00:00Z --to 2026-09-02T00:00:00Z --json
```

## 离线校准

若一个稳定窗口已经有模型输出和人工记录的 CF Dashboard 数字，可在本地创建临时
成对数据，再拟合乘数。运行模型本身不会读取 CF：

```json
{
  "observations": [
    {
      "estimate": {
        "workers_calls": 0,
        "r2_class_a": 0,
        "r2_class_b": 0,
        "r2_requests": 0,
        "d1_queries": 0,
        "d1_rows_read": 0,
        "d1_rows_written": 0
      },
      "actual": {
        "workers_calls": 0,
        "r2_class_a": 0,
        "r2_class_b": 0,
        "r2_requests": 0,
        "d1_queries": 0,
        "d1_rows_read": 0,
        "d1_rows_written": 0
      }
    }
  ]
}
```

示例中的零值只是结构占位，真实校准必须使用正数且窗口、时区、版本和部署状态
一致。拟合器对每个指标使用实际值/估计值的中位数作为点乘数，并用 p10/p90 形成
范围：

```bash
/Users/marknkx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/usage-model.mjs --fit-calibration /private/tmp/pairs.json \
  --write-calibration /private/tmp/usage-model-calibration.json --json
```

校准文件只有在确认对应窗口没有重复部署、批量任务、迁移、历史回补或 CF 聚合延迟
后才应替换。每次替换都应保留旧文件副本，并在开发日志写清楚窗口和误差；不要
为了追某一次异常尖峰直接修改先验。

## v1.2 历史基线（只读复核）

2026-09-02 的一次线上只读运行使用站点公开状态快照，窗口为
`2026-09-01T10:28:52Z` 至 `2026-09-02T10:28:52Z`。快照显示：36 个目标
（TCP 33、HTTP 3）、32 个 Agent、2 个外部 Latency 节点、5 个 Ping 目标。由于这次没有管理员会话，
debug 日志标记为不可用，置信度为 `low`。v1.2 点估计如下；右侧人工对账值来自同拓扑
Cloudflare Dashboard 截图，均已四舍五入，不能当作实时 CF API 返回值：

| 指标 | v1.2 点估计 | 运营低–高范围 | 同拓扑 CF 对账 |
| --- | ---: | ---: | ---: |
| Workers Functions 调用 | 52,332 | 45,006–59,658 | 52,320 |
| R2 Class A | 6,624 | 6,094–7,286 | 6,620 |
| R2 Class B | 18,624 | 16,017–21,231 | 18,630 |
| R2 请求分布 | 32,216 | 26,417–39,304 | 32,230 |
| D1 查询总数 | 294,047 | 264,642–323,452 | 294,000 |
| D1 已读取行 | 1,996,033 | 1,397,223–3,093,851 | 2,000,000 |
| D1 已写入行 | 93,082 | 83,774–125,661 | 93,000 |

这次校准把公开 Worker 请求从 0.3 调到 0.42 req/s，把 R2 公开读取率调到 0.38，
并把 D1 扫描行/写入行因子改为 2.65/1.92；因此点估计与该对账窗口的最大差异约为 0.3%。
这只是离线校准背景，不会变成运行时的 CF 输入。以后判断线上是否偏离，仍应在同一 UTC
窗口结束后同时保存模型 JSON 和 CF Dashboard 数字，再使用离线拟合；不能把不同滚动窗口的截图直接相减。

## 误差边界与后续规则

仅靠现有站点日志无法数学上恢复三类信息：

1. 所有公开动态请求的真实数量及缓存命中路径；
2. WSS Durable Object 的每次建连、重连和失败 fallback；
3. CF Dashboard 的计费分类、滚动窗口边界和聚合延迟。

因此 v1.2 的目标是“固定输入、固定公式、同口径校准、日常运营区间、可选压力上界、可用历史窗口再校准”，不是宣称
从站点日志得到 CF 的逐请求账单。为了省额度，模型没有向生产 Worker 增加新的逐请求
埋点；若将来要把置信度从 `low` 提高，优先扩展已有站点日志的脱敏计数或导出机制，
并先评估它本身增加的 Worker/D1/R2 消耗。

涉及以下任一变化时，必须把模型版本从 `usage-model-v1.3.3` 升级，并重新审查校准：

- Agent 报告、任务、更新策略、Ping 或 Latency 默认间隔变化；
- WSS、HTTP fallback、Durable Object、R2 flush 或 ProbeHistory 路径变化；
- D1 SQL profile、批量方式、快照/流量持久化周期变化；
- 公开 API 缓存策略或前端轮询行为变化。

只有文案、CSS 或不影响上述资源路径的 UI 修改，不需要改变模型版本，但仍应在开发
日志中记录“模型未受影响”。


v1.3.3 同步方案 A 的调度写入口径：探测节奏完全由 R2 状态承载后，D1 的
`targets` 调度镜像（last_checked_at/next_probe_at）降级为每目标每
`TARGET_SCHEDULE_FLUSH_SEC`（默认 1800 秒）一次的粗粒度回写，模型中
`d1_probe_persist` 事件改为按"目标数 × 每 30 分钟"估算。
