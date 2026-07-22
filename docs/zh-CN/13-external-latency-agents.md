# 13 外部 Latency Agent 部署与排障

外部 Latency Agent 是独立于普通 VPS 监控 Agent 的轻量 TCP 延迟探针。它可以部署在家庭宽带、云服务器或不同运营商网络中，从多个网络位置测量同一批公开 TCP 目标。

## 先区分四条数据链路

| 数据 | 发起方 | 用途 |
| --- | --- | --- |
| CF Latency | Cloudflare Worker / Durable Object | 测量 Cloudflare 到目标的 TCP 延迟 |
| VPS Agent 指标 | 被监控 VPS 上的 Rust Agent | 上报 CPU、内存、磁盘、流量和在线状态 |
| Agent TCP Ping | 被监控 VPS 上的 Rust Agent | 测量该 VPS 到后台 Ping 目标的延迟 |
| 外部 Latency Agent | 独立 Linux 节点上的 Python 服务 | 从额外网络位置测量所有公开 TCP 目标 |

后台创建一条 Latency 节点记录，只代表节点 ID 已存在。只有节点成功提交结果后，“最近上报”才会出现时间，公开页面的 Latency 图例中才会增加该来源。

## 适用范围

- Linux，并使用 systemd 管理服务。
- 系统可执行 Python 3 和 `curl`。
- 节点能通过 HTTPS 访问 Worker API 和 Pages 安装域名。
- 只探测已启用、类型为 TCP、公开地址与端口完整、且没有启用“隐藏公网地址”的目标。

外部 Latency Agent 不安装 Rust 指标 Agent，不上报自身 CPU、内存或流量，也不需要监听公网端口。

## 创建与部署

1. 登录管理后台，进入“Latency”。
2. 点击“新增节点”，填写稳定且能表示网络位置的名称。
3. 保存后点击该节点的“部署”。
4. 复制当前弹窗生成的完整 Linux 命令。
5. 在对应 Linux 节点上以 root 身份执行，不要复用另一个节点的命令。

安装命令包含节点专用 scoped Token，属于敏感凭据。不要发到公开 Issue、聊天记录、截图或 shell 教程中。

安装器会：

1. 检查 systemd 和 Python 3。
2. 停止并禁用已有的 `nstatus-latency-agent.service`，再终止仍引用旧脚本的残留进程。
3. 下载带版本参数的最新 `latency-agent.py`。
4. 写入权限为 `0600` 的环境文件。
5. 执行一次 `--once` 预检并提交首批结果。
6. 创建并启动 `nstatus-latency-agent.service`。
7. 验证 systemd 服务处于 active 状态。

因此同一节点需要重装或更换 Token 时，直接执行后台当前生成的新命令即可。安装器不会保留旧的 Latency Agent 进程并行上报。

成功输出形态类似：

```text
Validating Latency API access and submitting an initial probe...
{"ok":true,"targets":38,"accepted":38}
External Latency Agent installed: latency-example
```

字段含义：

- `targets`：Worker 返回给该节点的可探测 TCP 目标数。
- `accepted`：Worker 实际接受并写入的结果数。
- 两者相等且大于 0，表示首次拉取、TCP 探测、Token 验证和结果写入整条链路已成功。

## 部署后验证

在节点上检查：

```bash
sudo systemctl is-active nstatus-latency-agent.service
sudo systemctl status nstatus-latency-agent.service --no-pager
sudo journalctl -u nstatus-latency-agent.service -n 100 --no-pager
```

需要手动再跑一次时：

```bash
sudo sh -c 'set -a; . /etc/nstatus-latency-agent.env; set +a; /usr/bin/python3 /opt/nstatus-latency/latency-agent.py --once'
```

成功后回到后台确认：

- 节点状态为启用。
- “最近上报”显示刚才的时间，不再是“尚未上报”。
- 等待状态缓存刷新后，公开页面打开任一符合条件的 VPS，Latency 图例出现 Cloudflare 和外部节点名称。

管理员也可以从 Worker 目录查询 D1：

```bash
npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT id,name,last_seen_at FROM latency_agents ORDER BY name;"

npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT node_id,COUNT(*) AS count,MAX(checked_at) AS newest FROM latency_results GROUP BY node_id;"
```

公开状态接口只展示未过期的最新来源。正常上报后通常在几十秒内可见；长时间无新结果的来源会按 Worker 的 stale 窗口暂时隐藏。

## 自动更新

后台设置页的“Agent 自动更新”开关同时控制普通 Rust Agent 和外部 Latency Agent。Latency Agent 使用自己的节点 scoped Token 定期读取 `/api/latency-agent/update-policy`：

- 关闭时只读取策略，不修改本地脚本。
- 开启时从安装命令记录的 HTTPS Pages 地址下载当前脚本。
- 下载后先限制文件大小、比较 SHA-256 并执行 Python 编译检查。
- 校验通过后在 `/opt/nstatus-latency` 内原子替换脚本，并通过 `exec` 重启当前进程。
- 更新检查失败只写入 journal，不会中止后续延迟探测；默认一小时后重试。

首次启用这项能力需要重新执行一次后台生成的最新部署命令，以写入安装源并更新 systemd 沙箱权限。以后脚本更新可自动完成。

## 旧节点升级

如果节点是在旧版安装脚本时期部署，后台可能一直显示“尚未上报”。不要只重启旧服务，应当：

1. 在后台重新点击该节点的“部署”。
2. 复制当前生成的新命令。
3. 在原节点重新执行完整安装命令。
4. 必须看到 `{"ok":true,...,"accepted":...}`，再认为升级完成。

旧 Python `urllib` 默认 User-Agent 可能被 Cloudflare Browser Integrity Check 以 1010 拦截，请求甚至不会进入 Worker。当前脚本显式发送 `NStatus-Latency/1.0`，通过 `--once` 在安装阶段立即发现 API、Token 或边缘安全策略问题，并在重装前清理旧服务与残留进程。

## 常见故障

### 后台存在节点，但显示“尚未上报”

这只说明 D1 中创建了节点记录，没有任何一次成功结果。检查：

1. 是否在正确机器执行了该节点最新生成的完整命令。
2. 安装输出是否出现 `accepted`，而不是只看到 systemd 安装成功。
3. 服务是否 active。
4. 日志是否持续出现 401、403、TLS、DNS 或连接错误。
5. 系统时间是否正确。

### 输出 401 未授权

- scoped Token 与节点 ID 不匹配。
- 使用了另一节点的旧安装命令。
- Worker 的 `AGENT_TOKEN` 在安装后被更换，派生 Token 随之变化。

处理方式是从后台为当前节点重新生成命令并完整重装，不要手工拼接 Token。

### 输出 Cloudflare 1010 或 403

确认 `/opt/nstatus-latency/latency-agent.py` 中存在明确的 `User-Agent` 请求头。最直接的修复是重新执行后台当前生成的安装命令，让安装器下载最新版脚本。

### `targets` 或 `accepted` 为 0

确认后台至少有一个：

- 已启用的 TCP 目标；
- `target_host` 和 `target_port` 均有效；
- 未启用隐藏公网地址。

HTTP 目标和没有公开地址的目标不会下发给外部 Latency Agent。

### 首次成功，前端仍只有 Cloudflare

1. 等待 Worker 状态缓存刷新，通常为几十秒。
2. 强制刷新页面。
3. 确认查看的是公开 TCP/VPS 目标，而不是 HTTP 或隐藏地址目标。
4. 查询 `latency_results` 是否有该 `target_id` 的最新数据。
5. 检查服务是否继续运行，避免首次结果超过 stale 窗口后被隐藏。

### 服务反复重启

```bash
sudo systemctl status nstatus-latency-agent.service --no-pager
sudo journalctl -u nstatus-latency-agent.service -n 200 --no-pager
```

不要把 `/etc/nstatus-latency-agent.env` 的完整内容贴到公开场所，其中包含节点 Token。

## 删除与停用

- 停用节点：保留历史，但不再作为有效来源展示。
- 删除节点：同时删除该节点的历史结果，属于不可逆操作。
- 改显示名称不需要重装；改为新节点 ID 后必须使用新命令部署。
