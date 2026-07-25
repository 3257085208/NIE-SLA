# 03 后台管理完整说明

后台入口通常是 `https://YOUR-PAGES/admin.html`。它是静态前端，所有修改最终通过 Worker Admin API 写入 D1。

## 登录流程

1. 输入 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。
2. 前端只向 `/api/auth/login` 发送一次账号密码。
3. 已启用 TOTP 时再输入 6 位验证码。
4. Worker 签发随机 session，D1 只保存 session 哈希、来源和过期时间。
5. 前端只把 session 放入当前标签页 `sessionStorage`，不保存密码。

可选 GitHub 登录使用 OAuth 用户名白名单、短期 state 和一次性票据，最终也换成相同的后台 session。启用 TOTP 时 GitHub 登录不能绕过第二因素。

关闭标签页、主动退出或 session 过期后需要重新登录。连续输错可能触发 D1 限流，出现“请求过于频繁”。等待限流窗口结束，不要持续重试。

## 修改管理员账号密码

打开“设置 → 管理员账号”，填写当前密码、新账号和新密码；启用 TOTP 时还要填写当前验证码。新密码至少 12 位，建议由密码管理器生成 20 位以上随机值。

首次保存会把凭据从 Worker 环境变量迁移到 D1。D1 只保存随机盐和 PBKDF2-SHA256 派生结果，不保存明文密码。修改成功后会注销其他管理会话，当前页面会换发一枚新 Session。

之后即使 `ADMIN_USERNAME` 或 `ADMIN_PASSWORD` 仍保留在 Worker 配置中，登录也优先使用 D1 凭据。环境变量继续作为初次部署来源，但不能覆盖已经迁移的账号。

## 忘记密码时强制重置

强制重置走 Cloudflare 控制面，不开放公网“忘记密码”接口，因此不需要额外维护长期 Reset Token。

在可信电脑上进入项目的 `worker` 目录，登录对应 Cloudflare 账号后执行：

```bash
npm install
npx wrangler login
npm run admin:reset -- --remote
```

命令会隐藏输入新密码，把 PBKDF2 记录写入绑定的 `nstatus-db`，并注销所有后台 Session。不要把密码写进命令行参数或聊天记录。

如果同时遗失 TOTP，再执行：

```bash
npm run admin:reset -- --remote --disable-totp
```

自定义 D1 名称时可附加 `--database 数据库名`。本地 Wrangler 数据使用 `--local`，生产恢复必须使用 `--remote`。

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
- 日色块：公开目标显示 CF 探测成功率；“无公网 IP”目标显示 Agent 心跳在线率。超过离线阈值的上报缺口会按日期记为离线；升级前仅按目标创建时间与当前系统运行时长保守回填可证明连续运行的区间，其他未知历史保持灰色。

## 部署 Agent

对 TCP/VPS 目标点击“部署 Agent”：

1. Worker 读取目标 ID。
2. 首次生成命令时创建只属于该 ID 的随机 Token；D1 保存哈希，并保存由 `TOTP_ENCRYPTION_KEY` 加密的明文副本供以后再次查看命令。
3. 根据当前公开前端 Origin 生成安装下载地址。
4. 固定期望版本和 manifest SHA-256。
5. 返回 Linux/Windows 命令。

完整命令含节点 Token，等同凭据。不要贴到公开聊天、Issue 或截图。

旧部署如果仍配置 `AGENT_TOKEN`，会继续使用原来的派生 Token，升级后现有 Agent 不会因此掉线。新部署不需要配置全局 Agent Token。

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

内置只保留“原版列表”。原卡片风格改为官方主题 ZIP，在“主题”页面上传并启用；主题切换只改变展示，不改变采集和数据。

## 前端外观与文案

设置页的“前端外观与文案”用于调整公共品牌、文案、颜色和模块显隐，无需修改或重新编译前端文件。CSS 主题可基于 `classic` 或主题专用 `cards` 布局，交互画布主题则可以完全自行布局。保存后，公开状态接口会返回最新配置；前端下次刷新状态时自动应用。

可配置内容包括：

- 浏览器标题、Favicon、左上角站点名称、副标题、品牌链接、Logo、卡片头像和图片尺寸。
- 右上角使用图片、文字或完全隐藏，以及对应链接和替代文字。
- 状态横幅、摘要、搜索、分组、故障、检查、图表、Latency、VPS 详情和页脚文案。
- 强调色、页面背景色、内容表面色。
- 页头、横幅、摘要、搜索、分组、地区筛选、卡片统计侧栏、故障、图表、卡片 Latency、VPS 详情、检查和页脚的独立显示开关。

摘要和状态文案可使用 `{count}`、`{value}`、`{site_name}`。图片和链接只接受 HTTPS 或站内相对路径；颜色只接受六位十六进制值。尺寸由 Worker 限幅，错误值会回退到默认配置。“恢复默认”只清除自定义外观，不会改变目标、主题、Agent 或监控数据。

## 流量、账单与报警

编辑单台 VPS 可以设置：

- 流量累计开关和额度。
- 统计模式。
- 到期时间、价格、币种和周期。
- 是否参与报警。
- 单机报警阈值覆盖。

详见 [05 流量与账单](05-traffic-billing.md) 和 [06 Telegram 与邮件报警](06-alerts.md)。

## 立即检查

“立即检查”调用受限频率的 `/api/probe-now`。它用于验证配置，不应当作高频监控按钮连续点击。

如果返回 429，等待限流窗口；如果只失败某个目标，查看该目标的具体错误，而不是重复检查全部目标。

## 后台安全习惯

- 在自己的设备登录。
- 使用密码管理器保存后台密码，不在普通笔记、截图或脚本中记录。
- 使用 TOTP。
- 操作完成后退出。
- 浏览器扩展较多的环境建议使用单独浏览器配置文件。
- 不在公共电脑开启“记住密码”。
