# 02 Cloudflare 从零部署（新手完整教程）

本文假设你：

- 有一个 Cloudflare 账号；
- 会复制粘贴命令；
- 不一定懂 Worker、D1、R2、Pages 这些名词。

读完并跟着做，你应该能搭出一套可运行的 NIE-SLA / NStatus：

1. 公开状态页（Pages）
2. API 与定时探测（Worker）
3. 配置与状态存储（D1）
4. 高频历史存储（R2）
5. 一台 VPS 上的 Agent
6. 后台管理入口

文中所有域名、Token、数据库 ID 都是**占位符**。请替换成你自己的值，不要把真实密钥写进 README、截图、Issue 或聊天记录。

---

## 0. 先搞懂：你到底要部署什么

可以把 NIE-SLA 理解成三层：

```text
浏览器访问状态页
        |
        v
Cloudflare Pages  （前端页面 + 安装脚本 + Agent 下载文件）
        |
        v
Cloudflare Worker （API、登录、Cron 探测、鉴权、报警）
        |
   +----+----+------------------+
   |         |                  |
   v         v                  v
  D1        R2            Durable Objects
配置/最新状态  高频历史指标     可选区域探测
```

再加第四个角色：

```text
你的 VPS
  └─ Rust Agent
       ├─ 每 1 秒本地采样 CPU/内存/磁盘/网络等
       ├─ 默认约每 5 分钟批量上报
       └─ 可按后台配置做 TCP Ping
```

请记住这三条监控链路，部署完成后排查时会反复用到：

| 链路 | 谁在工作 | 回答什么问题 | 默认频率 |
| --- | --- | --- | --- |
| CF HTTP/TCP 探测 | Cloudflare Worker | 从 Cloudflare 看目标是否可达 | 约 5 分钟 |
| Agent 心跳与指标 | VPS 上的 Agent | 这台机器是否还活着、资源怎样 | 1 秒采样，约 5 分钟上传 |
| Agent TCP Ping | VPS 上的 Agent | 从这台 VPS 到指定目标的延迟 | 默认 20 秒 |

**常见误解**：Agent 离线不等于网页一定打不开；网页打不开也不等于 VPS 关机。三条链路要分开看。

---

## 1. 你需要准备什么

### 1.1 账号与权限

1. Cloudflare 账号
2. 能使用：
   - Workers
   - Pages
   - D1
   - R2
3. 建议至少有一个域名（可选，但强烈推荐）

没有自定义域名也能先用：

- Worker：`https://nstatus.<你的子域>.workers.dev`
- Pages：`https://nstatus.pages.dev` 或 `https://<项目名>.pages.dev`

生产环境更推荐：

```text
status.example.com  -> Pages  状态页/后台
api.example.com     -> Worker API
```

### 1.2 本地电脑软件

至少需要：

| 软件 | 用途 | 建议版本 |
| --- | --- | --- |
| Git | 克隆仓库 | 任意较新版本 |
| Node.js | 运行 `npx wrangler` | 18+ |
| npm | 随 Node 一起安装 | 随 Node |
| 终端 | 执行命令 | macOS/Linux Terminal 或 Windows 的 Git Bash |

Windows 用户请优先安装 [Git for Windows](https://git-scm.com/download/win)，后面的 `bash deploy.sh` 要用 Git Bash，不要用纯 CMD 硬跑 bash 脚本。

验证：

```bash
node --version
npm --version
git --version
npx wrangler --version
```

如果 `npx wrangler --version` 第一次很慢，属于正常，它在下载 Wrangler。

### 1.3 建议先准备 4 个随机密钥

在本机生成，分别执行 4 次：

```bash
openssl rand -hex 32
```

把输出分别保存到你自己的密码管理器，命名建议：

| 名称 | 用途 | 能不能发给 VPS |
| --- | --- | --- |
| `ADMIN_TOKEN` | 后台最高权限 | **不能** |
| `AGENT_TOKEN` | 生成每台机器专用 scoped Token 的主密钥 | **不要直接下发** |
| `TOTP_ENCRYPTION_KEY` | 加密后台 TOTP secret | **不能** |
| `ALERT_ENCRYPTION_KEY` | 可选，加密 Telegram Bot Token | **不能** |

硬规则：

- `ADMIN_TOKEN` 和 `AGENT_TOKEN` **必须不同**
- 不要用生日、站点名、`123456`、`password`
- 不要写进 Git 仓库
- 不要截图发群
- 不要放进前端 `config.js`

Windows 若没有 `openssl`，可在 Git Bash 里执行，或用 PowerShell：

```powershell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]]).ToLower()
```

---

## 2. 推荐部署路径

### 2.1 点一下部署到 Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

这个入口使用 Cloudflare 官方 Deploy Button。授权 GitHub 与 Cloudflare 后，平台会自动 Fork 仓库、创建 D1/R2、绑定 Durable Object、配置 Cron，并把 Worker API 与前端静态资源发布到同一个 `workers.dev` 域名。

部署页只要求你设置三个不能由模板预置的安全值：

- `ADMIN_TOKEN`：后台登录口令。
- `AGENT_TOKEN`：派生节点专用 Token 的主密钥。
- `TOTP_ENCRYPTION_KEY`：加密 TOTP Secret 的主密钥。

三项必须不同，建议由密码管理器各生成至少 32 字节随机值。一键构建会下载本仓库最新公开 Release 的 Agent 文件，并用 `SHA256SUMS` 逐个校验。部署成功后直接打开 Cloudflare 给出的 Worker URL，后台地址为 `/admin.html`。

Cloudflare Deploy Button 目前不支持 Pages，因此一键版使用 Worker Static Assets 提供前端。这与下文 Worker + Pages 分离部署的数据和 API 兼容；以后需要独立域名时可以再迁移到分离结构。

### 2.2 本地一键脚本

如果你是第一次部署，优先走这一节。手动部署只在脚本失败或你要精细控制时使用。

### 2.3 克隆仓库

公开示例仓库：

```bash
git clone https://github.com/3257085208/NIE-SLA.git
cd NIE-SLA/worker
```

如果你使用自己的私有生产仓库，把上面 URL 换成你的私有 Agent 仓库即可，然后同样进入：

```bash
cd worker
```

请确认当前目录下有这些文件：

```text
deploy.sh
wrangler.toml
src/
```

并且上一级有：

```text
../frontend/
../agent/
```

### 2.4 登录 Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`login` 会打开浏览器让你授权。授权成功后，`whoami` 应显示你的 Cloudflare 账号邮箱。

**多账号用户务必看一眼**：D1/R2/Worker 会建在当前登录账号下。登错账号是新手最常见的翻车点。

没有图形界面的服务器怎么办？

- 更推荐在自己电脑完成首次部署；
- 或使用权限受限的 Cloudflare API Token，而不是 Global API Key。

### 2.5 运行部署向导

仍在 `worker/` 目录：

```bash
bash deploy.sh
```

脚本会依次做这些事：

1. 检查 Node.js / Wrangler
2. 检查是否已登录
3. 询问站点名称、时区偏移
4. 创建或复用 D1：`nstatus-db`
5. 创建或复用 R2：`nstatus-archive`
6. 写入 Secrets
7. 询问 Worker 公网 URL
8. 生成/覆盖当前目录 `wrangler.toml`
9. 部署 Worker
10. 写入前端 `config.js`
11. 部署 Pages
12. 可选创建示例 HTTP 目标

### 2.6 脚本会问你什么，怎么填

| 提示 | 示例 | 说明 |
| --- | --- | --- |
| Site name | `NStatus` / `聶.NET` | 站点显示名 |
| Timezone offset minutes | `480` | 东八区是 `480`；东九区 `540`；UTC `0` |
| Admin token | 粘贴你准备的 `ADMIN_TOKEN` | 留空表示保留已有值 |
| Agent token | 粘贴你准备的 `AGENT_TOKEN` | 留空表示保留已有值 |
| TOTP encryption key | 粘贴 `TOTP_ENCRYPTION_KEY` | 首次部署建议填写 |
| Worker URL | `https://nstatus.你的账号.workers.dev` | 必填；不要末尾斜杠 |
| Pages project name | `nstatus` | Pages 项目名，不一定等于 GitHub 仓库名 |
| Add sample targets? | `Y` 或 `n` | 第一次可填 `Y` 方便验收 |

时区换算速查：

| 时区 | 填写值 |
| --- | ---: |
| UTC | `0` |
| 中国 / 新加坡（UTC+8） | `480` |
| 日本 / 韩国（UTC+9） | `540` |
| 美国东部冬令时（UTC-5） | `-300` |

### 2.7 如何拿到 Worker URL

如果这是第一次部署：

1. 可以先填一个预估值，例如：
   `https://nstatus.<subdomain>.workers.dev`
2. 更稳妥的做法是：
   - 先完成到“Deploying Worker...”前后
   - 看 `npx wrangler deploy` 输出的 `https://....workers.dev`
   - 再把该 URL 填回脚本，或部署完成后按“手动修正前端 config.js”一节处理

部署成功后，脚本通常会打印类似：

```text
Status page: https://nstatus.pages.dev
API:         https://nstatus.xxxx.workers.dev
```

把这两行保存好。

### 2.8 脚本失败时怎么办

不要连续狂按。先看**最后一条失败信息**。

常见情况：

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| Need Node.js 18+ | Node 没装或太旧 | 安装/升级 Node |
| Need wrangler | 网络差导致 npx 失败 | 重试，或 `npm i -g wrangler` |
| login 失败 | 浏览器授权中断 | 重新 `npx wrangler login` |
| D1 create 失败 | 账号未开通、权限不足、登错号 | `npx wrangler whoami` 后重试 |
| R2 create 失败 | 账号未启用 R2 | Cloudflare Dashboard 启用 R2 |
| Worker URL is required | 没填 Worker 公网地址 | 补上 `https://...` |
| Pages project 报错 | 项目名不存在/无权限 | 换项目名或先在 Dashboard 创建 |

好消息：D1 / R2 创建通常是幂等的。重复跑脚本一般会复用已有资源，不会无限造新库。

---

## 3. 部署后立刻做的 5 个验证

把下面的域名换成你的。

### 3.1 Worker 健康检查

```bash
curl -fsSL https://YOUR-WORKER.example/api/health
```

期望：

- HTTP 200
- JSON 里有 `"ok": true`
- 有站点名 / 时间 / Worker 版本一类字段

如果这里都失败，先别装 Agent，先修 Worker。

### 3.2 打开状态页

浏览器访问：

```text
https://YOUR-PAGES.example/
```

期望：

- 页面能打开
- 控制台没有大片模块加载失败
- 不是空白页

### 3.3 打开后台

```text
https://YOUR-PAGES.example/admin.html
```

用 `ADMIN_TOKEN` 登录。

### 3.4 看状态 API

```bash
curl -fsSL https://YOUR-WORKER.example/api/status
```

应返回 JSON，而不是 HTML 错误页。

### 3.5 看 Agent 发布文件是否随前端上线

```bash
curl -fsSL https://YOUR-PAGES.example/bin/VERSION
curl -fsSL https://YOUR-PAGES.example/bin/SHA256SUMS
```

这两项存在，后台生成的安装命令才能下载到正确版本。

---

## 4. 首次后台配置（非常重要）

### 4.1 登录

1. 打开 `/admin.html`
2. 输入 `ADMIN_TOKEN`
3. 如果还没开 TOTP，会直接进入
4. 如果已开 TOTP，再输入 6 位验证码

后台凭据只存在当前标签页的 `sessionStorage`。关掉标签页后需要重新登录，这是正常安全设计。

### 4.2 立刻启用 TOTP（强烈建议）

路径：设置 → TOTP

1. 点击启用
2. 用 1Password / Aegis / Google Authenticator 等扫描或录入 secret
3. 输入当前 6 位码确认
4. 退出后台
5. 重新走一遍“Token + TOTP”登录

注意：

- `TOTP_ENCRYPTION_KEY` 负责加密存放在 D1 里的 TOTP secret
- 你以后如果换了这个密钥，旧 TOTP secret 可能解不开，需要重设

### 4.3 先加一个简单 HTTP 目标做冒烟

建议第一次不要直接上 VPS，先加一个稳定网站：

- 名称：`Example Site`
- 类型：HTTP
- URL：`https://example.com`
- 期望状态码：`200,301,302`

保存后点“立即检查”或等一个 Cron 周期。

成功标准：

- 目标状态变为 online/up 一类正常态
- 有 latency
- 有最近检查时间

这一步确认的是：**Worker Cron + D1 写入 + 前端展示** 是通的。

### 4.4 再添加第一台 VPS 目标

后台进入探针管理，新增 TCP / VPS 目标：

| 字段 | 怎么填 |
| --- | --- |
| 名称 | 前端显示名，例如 `HK-CMI-01` |
| ID | 建议稳定、好记、以后不改，例如 `hk-cmi-01` |
| 主机 | IPv4 / 域名 / DNS-only AAAA 域名 |
| 端口 | 这台机器上真实在听的公网 TCP 端口 |
| 区域 | 不懂就先 `auto` |
| 分组 | 可先空，后面再按商家/地区/价格整理 |

重要：

- **ID 创建后尽量永远不要改**
- ID 绑定 Agent 身份和 scoped Token
- 改 ID 约等于新建一台节点，历史会断

### 4.5 生成并安装 Agent

1. 在该目标上点击“部署 Agent”
2. 复制后台生成的 Linux 或 Windows 命令
3. **只在对应那一台机器执行**
4. 回到后台看：
   - Agent 版本是否出现
   - `last_metrics_at` / 最后上报时间是否更新

Linux 示例形态类似：

```bash
curl -fsSL https://YOUR-PAGES.example/install.sh | sudo sh -s -- ...
```

不要：

- 把 A 机器命令贴到 B 机器
- 手工改别人的 Token 乱复用
- 从聊天记录复制过期命令

安装成功后，在 VPS 上执行：

```bash
sudo cftz status
sudo cftz log 50
```

期望看到服务运行中，且没有持续鉴权失败。

### 4.6 可选：部署外部 Latency 节点

如果需要从家庭宽带、不同云厂商或运营商网络测量所有公开 TCP 目标：

1. 后台进入“Latency”。
2. 新增一个表示网络位置的节点。
3. 点击“部署”，在对应 Linux/systemd 节点执行完整命令。
4. 确认安装输出包含 `{"ok":true,"targets":N,"accepted":N}`，且 `accepted` 大于 0。
5. 回到后台确认“最近上报”出现时间，再到公开页面检查 Latency 图例。

仅在后台新增节点并不等于部署成功。完整教程见 [13 外部 Latency Agent 部署与排障](13-external-latency-agents.md)。

---

## 5. 自定义域名（推荐）

### 5.1 推荐结构

```text
status.example.com  -> Cloudflare Pages
api.example.com     -> Cloudflare Worker
```

### 5.2 Pages 绑定自定义域名

1. Cloudflare Dashboard → Workers & Pages → 你的 Pages 项目
2. Custom domains → 添加 `status.example.com`
3. 按提示完成 DNS

### 5.3 Worker 绑定自定义域名

1. Workers & Pages → 你的 Worker
2. Triggers / Domains & Routes
3. 添加 `api.example.com`

### 5.4 绑定后必须同步的两处配置

#### A. 前端 API Base

`frontend/config.js` 最终应指向你的 API：

```js
window.NSTATUS_API_BASE = "https://api.example.com";
```

或由部署配置写入等价字段。**不要**依赖浏览器 URL 上的 `?api=` 覆盖。

改完后重新部署 Pages：

```bash
cd frontend
npx wrangler pages deploy . --project-name nstatus
```

#### B. Worker 公开变量

`worker/wrangler.toml` 中至少应一致：

```toml
PUBLIC_WORKER_URL = "https://api.example.com"
PUBLIC_AGENT_API_BASE = "https://api.example.com"
```

如果文档/脚本还写了站点来源，也一并改成你的 Pages 域名。

然后：

```bash
cd worker
npx wrangler deploy
```

### 5.5 HTTPS 要求

Agent 默认要求 API 是 HTTPS。公网明文 HTTP 会被拒绝，除非你明确处于受控私网并打开对应不安全开关。新手公网部署请始终使用 HTTPS。

---

## 6. 手动部署（脚本不可用时）

如果你想完全手控，或 `deploy.sh` 中途失败后要补齐，按下面做。

### 6.1 创建 D1

```bash
cd worker
npx wrangler d1 create nstatus-db
```

输出里会有类似：

```text
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

复制这个 ID。

查看已有库：

```bash
npx wrangler d1 list
```

### 6.2 创建 R2

```bash
npx wrangler r2 bucket create nstatus-archive
```

查看：

```bash
npx wrangler r2 bucket list
```

### 6.3 准备 `wrangler.toml`

至少需要这些部分（值请替换）：

```toml
name = "nstatus"
main = "src/index.js"
compatibility_date = "2026-06-17"
workers_dev = true

[triggers]
crons = ["*/5 * * * *"]

[vars]
PUBLIC_SITE_NAME = "NStatus"
PUBLIC_WORKER_URL = "https://api.example.com"
PUBLIC_AGENT_API_BASE = "https://api.example.com"
TIMEZONE_OFFSET_MINUTES = "480"
CONCURRENCY = "40"
MAX_TARGETS_PER_RUN = "60"
CHECKS_DEFAULT_LIMIT = "864"
CHECKS_WINDOW_HOURS = "72"
AGENT_METRICS_TO_D1 = "false"
AGENT_PINGS_TO_D1 = "false"
AGENT_METRICS_R2_RETENTION_HOURS = "72"
STATUS_CACHE_TTL = "20"
RATE_LIMIT_D1 = "true"
MISSED_WRITE_BACKFILL_MAX_BUCKETS = "6"

[[d1_databases]]
binding = "DB"
database_name = "nstatus-db"
database_id = "你的-database-id"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "nstatus-archive"

[[durable_objects.bindings]]
name = "REGION_PROXY"
class_name = "ProbeRegion"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ProbeRegion"]
```

说明：

- `AGENT_METRICS_TO_D1=false` 和 `AGENT_PINGS_TO_D1=false` 是为了保护免费额度：高频历史走 R2
- `CONCURRENCY` / `MAX_TARGETS_PER_RUN` 限制单次 Cron 压力
- 生产环境 Cron 也可能是每分钟触发、内部再按目标间隔调度；以你实际 `wrangler.toml` 为准

### 6.4 写入 Secrets

一定要用交互式命令，避免密钥进 Shell 历史：

```bash
cd worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put TOTP_ENCRYPTION_KEY
# 可选
npx wrangler secret put ALERT_ENCRYPTION_KEY
```

每条命令会提示你粘贴值。粘贴后回车即可。

不要这样：

```bash
echo "my-token" | npx wrangler secret put ADMIN_TOKEN   # 不推荐
```

### 6.5 部署 Worker

```bash
cd worker
npx wrangler deploy
```

成功后记录：

- Worker URL
- Version ID（以后回滚会用到）

验证：

```bash
curl -fsSL https://YOUR-WORKER.example/api/health
```

### 6.6 配置并部署前端

编辑 `frontend/config.js`，确保 API Base 指向 Worker：

```js
window.NSTATUS_API_BASE = "https://YOUR-WORKER.example";
```

然后：

```bash
cd frontend
npx wrangler pages deploy . --project-name nstatus
```

如果项目不存在，先创建：

```bash
npx wrangler pages project create nstatus
```

或在 Dashboard → Workers & Pages → Create → Pages 里创建同名项目。

### 6.7 确认 Agent 二进制随 Pages 发布

前端发布目录中应包含类似：

```text
frontend/bin/VERSION
frontend/bin/SHA256SUMS
frontend/bin/nstatus-metrics-linux-amd64
...
frontend/install.sh
```

如果这些文件缺失，后台安装命令会下载失败。公开示例仓库和私有生产前端仓库都应带上对应发布文件。

---

## 7. 安装第一台 Agent（逐步）

### 7.1 Linux VPS 安装前检查

```bash
uname -m
cat /etc/os-release
command -v curl
command -v sudo
```

确认：

1. 机器能访问 Pages 域名（下载）
2. 机器能访问 Worker/API 域名（上报）
3. 系统时间大致正确（偏差太大会影响 TOTP 和证书校验体验）

架构对照：

| `uname -m` | 通常使用 |
| --- | --- |
| `x86_64` | `linux-amd64` |
| `aarch64` / `arm64` | `linux-arm64` |
| `armv7l` | `linux-arm` |

不要把 amd64 二进制硬拷到 ARM 机器。

### 7.2 执行后台生成命令

推荐始终用后台按钮生成的命令。安装器会：

1. 识别架构
2. 下载 `VERSION` / `SHA256SUMS` / 对应二进制
3. 校验哈希和版本
4. 创建低权限运行用户
5. 写入受保护的环境文件
6. 安装 systemd/OpenRC 服务
7. 安装 `cftz` 管理工具
8. 启动服务

### 7.3 安装后检查

```bash
sudo cftz status
sudo systemctl status nstatus-metrics --no-pager
sudo journalctl -u nstatus-metrics -n 100 --no-pager
```

后台应逐步出现：

- Agent 版本（例如 `v1.0.17`）
- 最近上报时间
- CPU / 内存等资源信息

如果 CF Latency 暂时失败，但 Agent 指标正常，先不要急着判机器宕机。尤其是 IPv6-only 或端口未真正对公网开放时，很常见。

### 7.4 Windows 机器

1. 后台切换到 Windows 安装命令
2. 以管理员 PowerShell 执行
3. 安装后用任务计划程序/服务状态确认常驻
4. 同样只允许在对应机器使用对应命令

---

## 8. IPv6 目标特别说明

Cloudflare Workers 的 TCP Socket **不能乱连 Cloudflare 自己的代理 IP**。  
因此给 VPS 做 TCP 探测时：

### 推荐做法

为这台 VPS 建一个 **DNS only**（灰云）AAAA 记录：

```text
probe-hk01.example.com  AAAA  2001:db8::10
Proxy status: DNS only
```

后台主机填：

```text
probe-hk01.example.com
```

端口单独填真实端口。

### 不推荐

- 直接对某个开启橙云的域名做任意 TCP 探测
- 期望 Cloudflare 代理层替你转发非 HTTP 的随意端口

更细的说明见：[12 IPv6 与 Cloudflare 探测](12-ipv6-cloudflare-probe.md)

---

## 9. 生产建议配置清单

部署能跑起来之后，再按这个清单收一遍：

### 9.1 安全

- [ ] `ADMIN_TOKEN` 足够长且随机
- [ ] `AGENT_TOKEN` 与 Admin 不同
- [ ] 已启用 TOTP
- [ ] 没有把主 Token 写进前端
- [ ] 没有把真实 `wrangler.toml` 数据库 ID / 域名提交到公开仓库
- [ ] 每台 VPS 使用自己的 scoped 安装命令

### 9.2 可用性

- [ ] `/api/health` 正常
- [ ] 状态页可打开
- [ ] 后台可登录
- [ ] 至少一个 HTTP 目标检查成功
- [ ] 至少一台 Agent 成功上报
- [ ] Cron 后 `checked_at` 会更新

### 9.3 免费额度友好

保持这些默认更稳妥：

```toml
AGENT_METRICS_TO_D1 = "false"
AGENT_PINGS_TO_D1 = "false"
AGENT_METRICS_R2_RETENTION_HOURS = "72"
CONCURRENCY = "40"
MAX_TARGETS_PER_RUN = "60"
```

容量估算见仓库 README 的免费额度章节，或 [安全与免费额度](10-security-free-tier.md)。

### 9.4 自动更新

- 自动更新开关建议先关
- 先在 1 台测试 VPS 验证新版本
- 确认无问题后再批量开启

---

## 10. 日常更新怎么发

### 10.1 只更新 Worker

```bash
cd worker
npx wrangler deploy
```

### 10.2 只更新前端

```bash
cd frontend
# 确认 config.js 仍指向正确 API
npx wrangler pages deploy . --project-name nstatus
```

### 10.3 更新 Agent 发布文件

1. 把新版本二进制、`VERSION`、`SHA256SUMS` 放到前端可下载路径（通常是 Pages 的 `/bin`）
2. 重新部署 Pages
3. 后台如开启自动更新，Agent 会按策略拉取
4. 未开启则到机器上执行：

```bash
sudo cftz update
```

### 10.4 回滚

| 组件 | 回滚方式 |
| --- | --- |
| Worker | Cloudflare Versions & Deployments 回到旧 Version ID |
| Pages | 回到旧 Deployment |
| Agent | 重新发布旧版 `/bin` 文件后手动更新；不建议盲目自动降级 |
| D1 | 代码回滚不会自动还原数据结构；改 schema 前先导出 |

---

## 11. 完整验收清单

复制这份，做完打勾：

### A. 平台资源

- [ ] Cloudflare 登录账号正确
- [ ] D1 `nstatus-db` 存在
- [ ] R2 `nstatus-archive` 存在
- [ ] Worker 部署成功
- [ ] Pages 部署成功
- [ ] Secrets 已设置：`ADMIN_TOKEN` / `AGENT_TOKEN` / `TOTP_ENCRYPTION_KEY`

### B. 公网入口

- [ ] `https://API/api/health` 返回 ok
- [ ] `https://PAGES/` 可打开
- [ ] `https://PAGES/admin.html` 可打开
- [ ] `https://PAGES/bin/VERSION` 可访问
- [ ] `https://PAGES/bin/SHA256SUMS` 可访问

### C. 后台与探测

- [ ] Admin Token 登录成功
- [ ] TOTP 启用并验证成功
- [ ] 创建 HTTP 测试目标成功
- [ ] 手动检查或等待 Cron 后状态更新
- [ ] 创建 VPS/TCP 目标成功

### D. Agent

- [ ] 使用该目标专属安装命令
- [ ] `cftz status` 正常
- [ ] 后台出现 Agent 版本
- [ ] 后台出现最近上报时间
- [ ] 资源图表开始有数据

### E. 可选增强

- [ ] 自定义域名生效
- [ ] Telegram 报警测试消息成功
- [ ] 自动更新策略符合预期
- [ ] IPv6 DNS-only 探测域名已配置

---

## 12. 常见问题排障

### 12.1 状态页能开，但数据全空

检查顺序：

1. 浏览器开发者工具 → Network
2. 看 `/api/status` 请求发去了哪里
3. 是否 404 / CORS / 502
4. `frontend/config.js` 是否指向正确 Worker

### 12.2 后台提示 Token 错误

- 确认输入的是 `ADMIN_TOKEN`，不是 `AGENT_TOKEN`
- 确认当前 Worker 就是你设置 secret 的那个
- 多环境时最容易 secret 设到 A，页面连到 B

### 12.3 后台提示请求过于频繁

登录/鉴权有 D1 限流。先等待窗口过去，不要脚本狂刷。

### 12.4 Agent 安装后不上报

在 VPS 上查：

```bash
sudo cftz status
sudo cftz log 100
sudo journalctl -u nstatus-metrics -n 100 --no-pager
```

重点看：

- API Base 是否正确
- Token 是否对应这个 target ID
- 是否 HTTPS 证书/域名问题
- 机器是否放行出站 443

### 12.5 Agent 在线，但 CF TCP 一直失败

通常不是 Agent 坏了，而是：

- 端口没对公网开放
- 填成了橙云代理域名
- IPv6 字面量/路由问题
- 安全组只放行了 80/443，没放行你填的端口

### 12.6 Pages 正常，API 404

- Worker 路由没绑好
- `config.js` 写错
- 自定义域名只绑了 Pages 没绑 Worker

### 12.7 新代码推了，页面还是旧的

- 看 Pages Deployment 对应的 commit / 时间
- 强刷浏览器
- 用 `wrangler pages deploy` 直接发布一次
- 静态资源可带随机 query 验证是否新文件

### 12.8 `Project not found`

```bash
npx wrangler pages project list
```

用列表里的**真实项目名**，不要假设它等于 GitHub 仓库名。

### 12.9 D1/R2 binding 不存在

- 是否在 `worker/` 目录执行
- `wrangler.toml` 的 database_id / bucket 名是否属于当前账号
- `npx wrangler whoami` 是否登对

### 12.10 Windows 上 `bash deploy.sh` 无法运行

请用 Git Bash：

```bash
cd /c/path/to/repo/worker
bash deploy.sh
```

不要在未安装 bash 的 PowerShell 里硬执行。

---

## 13. 安全底线（部署时就遵守）

1. 永远不要提交真实 Secret 到 Git
2. 永远不要把 `ADMIN_TOKEN` 发给 VPS
3. 永远不要把一台机器的安装命令复用到另一台
4. 公开仓库只放占位符域名和假 database_id
5. 生产配置与公开示例必须分离
6. 截图前遮挡 Token、session、安装命令中的密钥参数

---

## 14. 最短成功路径（给你对照）

如果你只想要最短顺序，按这个走：

1. 安装 Node.js + Git
2. `git clone` 仓库
3. `cd worker`
4. `npx wrangler login`
5. 准备 3 到 4 个随机密钥
6. `bash deploy.sh`
7. 验证 `/api/health`
8. 打开 Pages 首页和 `admin.html`
9. 启用 TOTP
10. 添加 HTTP 测试目标
11. 添加 VPS 目标
12. 用后台命令安装 Agent
13. `cftz status` 确认上报
14. 再考虑自定义域名和 Telegram

---

## 15. 下一步阅读

- [03 后台管理](03-admin.md)：Token/TOTP、目标、分组、主题、更新开关
- [04 Agent 安装与维护](04-agent.md)：采样、队列、更新、卸载、日志
- [07 配置参考](07-configuration.md)：环境变量与 `wrangler.toml`
- [09 运维与故障排查](09-operations.md)：线上排障
- [10 安全与免费额度](10-security-free-tier.md)：安全边界和容量
- [12 IPv6 与 Cloudflare 探测](12-ipv6-cloudflare-probe.md)：IPv6 专项

---

## 附录 A. 部署时会创建哪些 Cloudflare 资源

| 资源 | 默认名 | 作用 |
| --- | --- | --- |
| Worker | `nstatus` | API、鉴权、Cron、报警 |
| Pages | `nstatus` | 状态页、后台、安装脚本、Agent 文件 |
| D1 | `nstatus-db` | 目标配置、最新状态、事件、限流、设置 |
| R2 | `nstatus-archive` | 高频指标和 Ping 历史等归档 |
| Durable Object | `ProbeRegion` | 可选按区域提示执行探测 |
| Secrets | `ADMIN_TOKEN` 等 | 敏感配置，不进代码仓库 |

## 附录 B. 你应该自己保存的信息

建议在密码管理器建一个条目，包含：

```text
站点名：
Pages 域名：
Worker/API 域名：
ADMIN_TOKEN：
AGENT_TOKEN：
TOTP_ENCRYPTION_KEY：
ALERT_ENCRYPTION_KEY（如有）：
D1 database_id：
R2 bucket：
Pages project name：
Worker name：
首次部署日期：
```

## 附录 C. 一键部署与手动部署怎么选

| 场景 | 建议 |
| --- | --- |
| 第一次搭 | 一键 `deploy.sh` |
| 脚本中途失败 | 看失败点，用手动步骤补齐 |
| 已有生产环境小改 | 手动 `wrangler deploy` / `pages deploy` |
| 多环境（测试/生产） | 手动，并分开 secret 与资源名 |
| 完全不懂 Cloudflare | 先一键，再回来读本文理解每一项 |
