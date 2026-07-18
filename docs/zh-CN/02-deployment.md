# 02 Cloudflare 从零部署

本文从一个空 Cloudflare 账号开始，解释自动和手动部署。示例中的域名、ID 和 Token 都是占位符。

## 1. 前置条件

本地安装：

```bash
node --version
npm --version
git --version
npx wrangler --version
```

推荐 Node.js 18 或更高版本、Wrangler 4.x。Windows 建议安装 Git for Windows，以便运行 Bash 安装脚本和统一测试。

## 2. 准备密钥

分别生成至少 32 字节随机值：

```bash
openssl rand -hex 32  # ADMIN_TOKEN
openssl rand -hex 32  # AGENT_TOKEN
openssl rand -hex 32  # TOTP_ENCRYPTION_KEY
openssl rand -hex 32  # ALERT_ENCRYPTION_KEY，可选
```

作用：

| Secret | 用途 | 是否下发到 VPS |
| --- | --- | --- |
| `ADMIN_TOKEN` | 后台最高权限 | 否 |
| `AGENT_TOKEN` | 派生节点 scoped Token | 不应直接下发主 Token |
| `TOTP_ENCRYPTION_KEY` | AES-GCM 加密 TOTP secret | 否 |
| `ALERT_ENCRYPTION_KEY` | 加密后台保存的 Telegram Bot Token | 否 |

## 3. 登录 Wrangler

```bash
npx wrangler login
npx wrangler whoami
```

确认输出的是准备部署的账号。多账号用户最容易在这里把 D1 建到错误账号。

## 4. 自动部署

```bash
git clone https://github.com/3257085208/NIE-SLA.git
cd NIE-SLA/worker
bash deploy.sh
```

脚本流程：

1. 检查 Node/Wrangler。
2. 创建或复用 `nstatus-db`。
3. 创建或复用 `nstatus-archive`。
4. 从当前 GitHub Release 下载 7 个 Agent 二进制、`VERSION` 和 `SHA256SUMS`。
5. 校验全部 Agent 文件并计算 manifest 自身哈希。
6. 写入 Worker secrets。
7. 询问 Worker URL、Pages 项目、Pages URL 和时区。
8. 生成只属于当前账号且被 Git 忽略的 `worker/wrangler.local.toml`。
9. 部署 Worker、Cron 和 Durable Object。
10. 写入前端 `config.js` 并将 Agent Release 文件一起部署到 Pages。
11. 可选创建示例目标。

脚本失败时不要反复盲跑，先看最后一个失败步骤。资源创建是幂等的，重复运行通常会复用已有 D1/R2。

## 5. 手动部署 Worker

### 创建 D1

```bash
npx wrangler d1 create nstatus-db
```

记录输出的 `database_id`，写入你自己的 `worker/wrangler.local.toml`。一键脚本会自动完成这一步。

仓库模板中的全零 UUID 只是防泄露占位符，不能直接部署：

```toml
[[d1_databases]]
binding = "DB"
database_name = "nstatus-db"
database_id = "替换为 wrangler d1 create 返回的 UUID"
```

### 创建 R2

```bash
npx wrangler r2 bucket create nstatus-archive
```

### 配置 secrets

```bash
cd worker
npx wrangler secret put ADMIN_TOKEN --config wrangler.local.toml
npx wrangler secret put AGENT_TOKEN --config wrangler.local.toml
npx wrangler secret put TOTP_ENCRYPTION_KEY --config wrangler.local.toml
npx wrangler secret put ALERT_ENCRYPTION_KEY --config wrangler.local.toml
```

命令会交互读取值，不要使用 `echo TOKEN | ...`，避免密钥出现在 Shell 历史或进程列表。

### 检查关键配置

生产建议：

```toml
[triggers]
crons = ["*/5 * * * *"]

[vars]
CONCURRENCY = "40"
MAX_TARGETS_PER_RUN = "60"
AGENT_METRICS_TO_D1 = "false"
AGENT_PINGS_TO_D1 = "false"
MISSED_WRITE_BACKFILL_MAX_BUCKETS = "6"
```

`CONCURRENCY=40` 的目的是让不超过 40 个目标在一个受控批次中运行。若目标数大于 40，应结合 Worker 执行时长和目标 timeout 做压力测试，不要无限提高并发。

### 部署

```bash
npx wrangler deploy --config wrangler.local.toml
```

记录输出的 Worker URL 与 Version ID。

### 验证健康接口

```bash
curl -fsSL https://YOUR-WORKER.example/api/health
```

预期：HTTP 200，JSON 中有 `ok=true`、站点名称、Worker 版本和时间。

## 6. 部署 Pages

修改 `frontend/config.js`：

```js
window.NSTATUS_API_BASE = "https://YOUR-WORKER.example";
```

直接上传：

```bash
cd frontend
npx wrangler pages deploy . --project-name nstatus
```

也可以把 Cloudflare Pages 连接到前端 GitHub 仓库。Git 集成适合日常自动部署；Wrangler 直接部署适合紧急发布和验证。

## 7. 配置自定义域名

推荐：

```text
status.example.com  -> Pages
api.example.com     -> Worker
```

如果 Pages Functions 代理 `/api/*` 到 Worker，Agent 安装命令可以统一使用 Pages 域名。无论哪种方式，Agent API 必须是 HTTPS。

若希望 `status.example.com/api/*` 不消耗 Pages Function 调用，可在确认域名属于当前 Cloudflare Zone 后加入 Worker Route：

```toml
routes = [
  { pattern = "api.example.com", custom_domain = true },
  { pattern = "status.example.com/api/*", zone_name = "example.com" },
]
```

这些配置绝不能原样复制：三个域名都必须替换为你拥有的域名。首页仍由 Pages 提供，只有 `/api/*` 交给 Worker。

## 8. Agent Release 文件

公共 Git 仓库不提交多平台二进制。创建 `v*` Tag 后，GitHub Actions 会构建并发布：

```text
nstatus-metrics-linux-amd64
nstatus-metrics-linux-arm64
nstatus-metrics-linux-arm
nstatus-metrics-linux-armv5
nstatus-metrics-linux-armv6
nstatus-metrics-linux-386
nstatus-metrics-windows-amd64.exe
SHA256SUMS
VERSION
```

`worker/deploy.sh` 会把当前 `agent/VERSION` 对应的 Release 下载到被 `.gitignore` 排除的 `frontend/bin/`。如果使用 Fork，请先在自己的 Fork 创建对应 Tag，或设置 `AGENT_RELEASE_BASE` 指向可信 Release。不要从不明镜像下载 Agent。

## 9. 首次后台配置

1. 打开 `https://status.example.com/admin.html`。
2. 输入 Admin Token。
3. 进入设置并启用 TOTP。
4. 新增一个测试 HTTP 目标。
5. 点击“立即检查”。
6. 新增一台测试 VPS TCP 目标。
7. 复制该目标的 Agent 安装命令。
8. 只在对应 VPS 上执行。

## 10. IPv6 目标

建议为 IPv6-only VPS 创建 DNS-only AAAA：

```text
probe-vps.example.com AAAA 2001:db8::10
Proxy status: DNS only
```

后台填写主机 `probe-vps.example.com`，端口单独填写。不要开启橙云；Workers TCP Socket 禁止连接 Cloudflare 自己的代理 IP。

## 11. 部署后验收清单

```bash
curl -fsSL https://status.example.com/bin/VERSION
curl -fsSL https://status.example.com/bin/SHA256SUMS
curl -fsSL https://api.example.com/api/health
```

然后检查：

- 首页没有 JavaScript 模块错误。
- 后台 Token/TOTP 登录正常。
- `/api/status` 返回目标。
- Cron 每 5 分钟更新 `checked_at`。
- Agent 版本和 `last_metrics_at` 更新。
- `cftz status` 显示服务运行。
- 自动更新开关符合预期。
- Telegram 测试消息能发送。

## 12. 回滚原则

- Worker：使用 Cloudflare Versions & Deployments 回滚到已知 Version ID。
- Pages：回滚到已知 Deployment。
- Agent：重新发布旧版 manifest 和对应二进制前必须理解降级兼容性，不建议自动降级。
- D1：删除/修改 schema 前先导出；代码回滚不等于数据库自动回滚。

## 13. 常见部署错误

### `Project not found`

Pages 项目名称不一定等于 GitHub 仓库名。运行：

```bash
npx wrangler pages project list
```

使用列表中的 Project Name。

### D1/R2 绑定不存在

确认 `wrangler.local.toml` 的 ID、bucket 名称和当前账号一致，并从 `worker/` 目录执行命令。

### Pages 正常但 API 404

检查 `config.js`、Pages Functions 路由和 Worker URL。浏览器开发者工具 Network 面板会显示请求实际发往哪里。

### 新代码已推送但页面仍旧

检查 Pages Deployment 对应的 commit hash；必要时使用 `wrangler pages deploy` 直接发布，再使用带随机查询参数的静态文件 URL 验证。

## 下一步

- [03 后台管理](03-admin.md)
- [04 Agent 安装与维护](04-agent.md)
- [09 运维与故障排查](09-operations.md)
