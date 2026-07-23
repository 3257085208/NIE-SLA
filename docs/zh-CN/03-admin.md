# 03 后台管理完整说明

后台入口通常是 `https://YOUR-PAGES/admin.html`。它是静态前端，所有修改最终通过 Worker Admin API 写入 D1。

## 登录流程

1. 输入 `ADMIN_TOKEN`。
2. 前端请求 `/api/login`。
3. 未启用 TOTP 时直接进入后台。
4. 已启用 TOTP 时输入 6 位验证码。
5. Worker 验证后签发随机 session，D1 只保存 session 哈希和过期时间。
6. 前端将 Token/session 放入当前标签页 `sessionStorage`。

关闭标签页、主动退出或 session 过期后需要重新登录。连续输错可能触发 D1 限流，出现“请求过于频繁”。等待限流窗口结束，不要持续重试。

## 启用 TOTP

进入“设置 → TOTP”：

1. 点击启用。
2. 将 secret 添加到支持 TOTP 的验证器。
3. 输入当前 6 位验证码确认。
4. 退出后重新登录验证完整流程。

`TOTP_ENCRYPTION_KEY` 用于加密 D1 中的 TOTP secret。更换该密钥会导致旧 secret 无法解密，需要重新设置。

## 探针管理

### NodeQuality 报告

编辑 TCP/VPS 探针时，可以把 NodeQuality 原始 Markdown 报告粘贴到“NodeQuality 报告”字段后保存。系统会解析 `:::: tabs` 报告中的基本信息、IP 质量、网络质量和回程路由：ANSI 文本保留终端颜色，网络质量和回程路由保留报告图片。再次提交空白内容即可清除报告。

保存后，公开 VPS 列表中的该节点会出现 `NQ` 按钮。点击按钮会从公开接口加载解析结果，弹窗顶部显示报告时间，并提供原报告链接。只有启用且类型为 TCP/VPS 的目标会公开 NodeQuality 报告；HTTP 目标不会显示该按钮。

### 名称与 ID

- 名称用于页面展示，可修改。
- ID 用于 D1 主键、Agent 身份和 scoped Token。
- 创建 Agent 后不要随意更换 ID；新 ID 相当于一台新节点。
- ID 只允许规范化后的 ASCII 字母、数字和有限标点。

### 类型

HTTP：

- 填完整 `https://` URL。
- 可配置请求方法和期望状态码。
- 默认把 2xx/3xx 视为成功。

TCP：

- 主机与端口分开填写。
- 只验证 TCP 三次握手，不验证应用层内容。
- VPS 目标可同时绑定同 ID Agent。

### IPv6

- 主机字段填 IPv6 时不带方括号，端口单独填。
- 更推荐填写 DNS-only AAAA 域名。
- 不要给任意 TCP 探测域名开启 Cloudflare 橙云。
- 详见 [IPv6 教程](12-ipv6-cloudflare-probe.md)。

### 区域

区域是 Durable Object location hint：

- `auto`：不指定区域。
- `wnam`：北美西部提示。
- `enam`：北美东部提示。
- `weur`/`eeur`：欧洲提示。
- `apac`：亚太提示。

它不是固定城市、固定 IP 或固定 colo 的承诺。详情中的区域标签说明使用哪个提示，不等同于 Agent 所在地区。

### 排序

后台可以拖动左侧手柄排序；移动端可用上移/下移按钮。保存后 Worker 更新 `sort_order`，前台和后台都按该值显示。

### 启用与删除

- 禁用：保留历史和配置，但 Cron 不再探测。
- 删除：删除目标及相关状态，属于不可逆管理操作。
- 更换地址建议编辑目标，不要删除后重建，否则历史连续性丢失。

## CF 状态、Agent 状态与 24h

后台表格故意区分：

- CF 状态：Cloudflare 外部探测。
- Latency：最近一次成功 CF 探测耗时。
- Agent：最近心跳是否在阈值内。
- 机器在线：Agent 上报的系统运行时长。
- 24h：Web 目标显示 CF 成功率；Agent 节点显示 Agent 在线/离线，避免用 CF 失败误导 VPS 状态。

## 部署 Agent

对 TCP/VPS 目标点击“部署 Agent”：

1. Worker 读取目标 ID。
2. 使用主 `AGENT_TOKEN` 派生只属于该 ID 的 scoped Token。
3. 根据当前公开前端 Origin 生成安装下载地址。
4. 固定期望版本和 manifest SHA-256。
5. 返回 Linux/Windows 命令。

完整命令含节点 Token，等同凭据。不要贴到公开聊天、Issue 或截图。

## Latency 节点

“Latency”页管理的是独立外部测量节点，不是普通 VPS 的 Rust Agent，也不是 Cloudflare 内置来源。

- Cloudflare 行是系统内置来源，不能删除。
- 新增外部节点只会创建节点 ID；在 Linux 上执行“部署”命令并成功提交后，才会出现“最近上报”。
- 安装成功输出应包含 `{"ok":true,"targets":N,"accepted":N}`。
- `accepted` 大于 0 后，公开 TCP/VPS 目标的 Latency 图例会增加该节点。
- 每个节点命令包含不同 scoped Token，不能跨节点复用。
- 编辑显示名称不需要重装；新建或更换节点 ID 后需要重新部署。
- 重复执行当前部署命令会先停止旧服务和残留进程，再启动唯一的新实例。

完整步骤和故障排查见 [13 外部 Latency Agent 部署与排障](13-external-latency-agents.md)。

## Ping 管理

Ping 目标由 Agent 定期拉取。格式通常为域名/IP与端口。Agent 按 `NSTATUS_PING_SEC` 从 VPS 本地发起连接。

修改 Ping 目标后不会要求重装 Agent；下一次拉取配置后生效。

## 自动更新

设置页开关控制 Worker 返回的 update policy：

- 开：支持自动安装的平台发现新版本后下载、校验并替换。
- 关：Agent 不主动修改自身。

开关同时控制普通 Rust Agent 与外部 Latency Agent，并且是动态读取，不是在安装时永久写死。关闭自动更新后，Rust Agent 仍可手动执行 `sudo cftz update`；Latency Agent 可重新执行后台生成的部署命令完成手动升级。

## 主题

“原版列表”和“卡片风格”只改变展示，不改变采集和数据。切换主题前后目标状态应相同。

## 流量、账单与报警

编辑单台 VPS 可以设置：

- 流量累计开关和额度。
- 统计模式。
- 到期时间、价格、币种和周期。
- 是否参与报警。
- 单机报警阈值覆盖。

详见 [05 流量与账单](05-traffic-billing.md) 和 [06 Telegram 报警](06-alerts.md)。

## 立即检查

“立即检查”调用受限频率的 `/api/probe-now`。它用于验证配置，不应当作高频监控按钮连续点击。

如果返回 429，等待限流窗口；如果只失败某个目标，查看该目标的具体错误，而不是重复检查全部目标。

## 后台安全习惯

- 在自己的设备登录。
- 不把 Admin Token 保存到密码以外的普通笔记。
- 使用 TOTP。
- 操作完成后退出。
- 浏览器扩展较多的环境建议使用单独浏览器配置文件。
- 不在公共电脑开启“记住密码”。
