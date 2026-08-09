# 外部 Latency Agent

外部 Latency Agent 是独立于 VPS 监控 Agent 的轻量 TCP 延迟探针，部署在家庭宽带、云服务器或其他运营商网络，从多个网络位置测量同一批公开 TCP 目标。

## 数据链路

| 数据 | 发起方 | 用途 |
| --- | --- | --- |
| CF Latency | Cloudflare Worker / Durable Object | Cloudflare 到目标的 TCP 延迟 |
| VPS Agent 指标 | 被监控 VPS 上的 Rust Agent | CPU、内存、磁盘、流量、在线状态 |
| Agent TCP Ping | 被监控 VPS 上的 Rust Agent | 该 VPS 到后台 Ping 目标的延迟 |
| 外部 Latency Agent | 独立 Linux 节点上的 Python 服务 | 额外网络位置到所有公开 TCP 目标的延迟 |

后台创建 Latency 节点记录只代表节点 ID 存在；节点成功提交结果后“最近上报”才会出现时间，公开页的 Latency 图例中才会增加该来源。

## 适用范围

- Linux + systemd。
- 可执行 Python 3 与 `curl`。
- 节点能通过 HTTPS 访问 Worker 站点域名与 API。
- 只探测已启用、类型为 TCP、公开地址与端口完整、且未启用“隐藏公网地址”的目标。

外部 Latency Agent 不安装 Rust 指标 Agent，不上报自身 CPU/内存/流量，也不需要监听公网端口。

## 创建与部署

1. 登录后台，进入“Latency”。
2. 新增节点，填写稳定且能表示网络位置的名称。
3. 保存后点击该节点的“部署”。
4. 复制弹窗生成的完整 Linux 命令。
5. 在对应节点以 root 身份执行，不要复用另一个节点的命令。

命令包含节点专用 scoped Token，属于敏感凭据，不要发到公开 Issue、聊天记录、截图或 shell 教程。

安装器会：检查 systemd 与 Python 3；停止并禁用已有的 `nstatus-latency-agent.service`，终止引用旧脚本的残留进程；下载带版本参数的最新 `latency-agent.py`；写入权限 `0600` 的环境文件；执行一次 `--once` 预检并提交首批结果；创建并启动服务；验证 active 状态。同一节点重装或换 Token 时直接执行后台当前生成的新命令即可。

成功输出类似：

```text
Validating Latency API access and submitting an initial probe...
{"ok":true,"targets":38,"accepted":38}
External Latency Agent installed: latency-example
```

`targets` 是 Worker 下发给该节点的可探测目标数，`accepted` 是实际接受并写入的结果数。两者相等且大于 0，说明拉取、探测、Token 验证与结果写入整条链路成功。

## 部署后验证

```bash
sudo systemctl is-active nstatus-latency-agent.service
sudo systemctl status nstatus-latency-agent.service --no-pager
sudo journalctl -u nstatus-latency-agent.service -n 100 --no-pager
```

手动再跑一次：

```bash
sudo sh -c 'set -a; . /etc/nstatus-latency-agent.env; set +a; /usr/bin/python3 /opt/nstatus-latency/latency-agent.py --once'
```

回到后台确认节点已启用、“最近上报”有时间；公开页打开任一符合条件的 VPS，Latency 图例出现 Cloudflare 与外部节点名称。公开状态接口只展示未过期的最新来源，正常上报后几十秒内可见，长时间无新结果的来源按 stale 窗口暂时隐藏。

从 Worker 目录查询 D1：

```bash
npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT id,name,last_seen_at FROM latency_agents ORDER BY name;"

npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT node_id,COUNT(*) AS count,MAX(checked_at) AS newest FROM latency_results GROUP BY node_id;"
```

## 自动更新

后台“Agent 自动更新”开关同时控制普通 Rust Agent 与外部 Latency Agent。Latency Agent 用节点 scoped Token 定期读取 `/api/latency-agent/update-policy`：

- 关闭时只读策略，不修改本地脚本。
- 开启时从安装命令记录的 HTTPS 地址下载当前脚本，限制大小、比较 SHA-256、执行 Python 编译检查，通过后在 `/opt/nstatus-latency` 内原子替换并 `exec` 重启。
- 更新检查失败只写 journal，不中止延迟探测，默认一小时后重试。

首次启用需要重新执行一次后台生成的最新部署命令，以写入安装源并更新 systemd 沙箱权限。

## 旧节点升级

旧安装脚本时期部署的节点可能一直显示“尚未上报”。不要只重启旧服务：在后台重新点击“部署”，复制新命令，在原节点完整重装，看到 `{"ok":true,...,"accepted":...}` 才算完成。

旧 Python `urllib` 默认 User-Agent 可能被 Cloudflare Browser Integrity Check 以 1010 拦截。当前脚本显式发送 `NIE-SLA-Latency/1.0`，并在安装阶段用 `--once` 立即发现 API、Token 或边缘安全策略问题。

## 常见故障

- 节点存在但“尚未上报”：确认在正确机器执行了该节点最新完整命令、安装输出出现 `accepted`、服务 active、日志无持续 401/403/TLS/DNS 错误、系统时间正确。
- 输出 401：scoped Token 与节点 ID 不匹配，或误用了另一节点的命令。从后台重新生成当前节点命令并完整重装，不要手工拼接 Token。
- Cloudflare 1010/403：确认脚本带有明确的 `User-Agent` 请求头，重新执行最新安装命令。
- `targets` 或 `accepted` 为 0：后台至少需要一个已启用、地址与端口完整、未隐藏的 TCP 目标。HTTP 目标不下发。
- 首次成功但前端只有 Cloudflare：等待状态缓存刷新（几十秒）、强制刷新、确认查看的是公开 TCP 目标、查询 `latency_results` 是否有最新数据。
- 服务反复重启：看 systemd 与 journal 日志。不要把 `/etc/nstatus-latency-agent.env` 完整内容贴到公开场所，其中包含节点 Token。

## 删除与停用

停用节点保留历史，但不再作为有效来源展示；删除节点同时删除该节点历史结果，不可逆。改显示名称不需要重装；节点 ID 变更后必须用新命令部署。
