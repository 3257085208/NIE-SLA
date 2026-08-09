# NIE-SLA 前端

本目录是 NIE-SLA 的生产前端源：公开状态页、管理后台、Agent 安装器、External Latency Agent 与校验过的发布二进制。GitHub 仓库 `3257085208/CloudflareStatus`（私有）。

新部署由 `agent/worker/scripts/prepare-assets.mjs` 复制为 Worker Static Assets，与 API 同源发布。目录中的 `functions/` 只兼容旧 Pages + Worker 部署的迁移期，不是新用户的部署主线。

## 目录

- `index.html` / `app.js` / `style.css`：公开状态页。
- `admin.html` / `js/admin.js`：管理后台。
- `js/shared/`：共享纯函数（图表、NQ 弹窗、解锁摘要等）。
- `js/themes.js`：主题引导与运行时。
- `functions/`：旧 Pages 路由兼容。
- `bin/`：Agent `VERSION`、`SHA256SUMS` 与五个架构的二进制。
- `install.sh`：Rust Agent 安装入口。
- `install-latency.sh` / `latency-agent.py`：External Latency Agent。
- `vendor/tasks/`：固定动作的已审计上游脚本快照。

## 单 Worker 构建

从私有 Agent/Worker 仓库执行：

```bash
cd ../agent/worker
node scripts/prepare-assets.mjs
npx wrangler deploy
```

生产发布用 `deploy.sh` 完成同样步骤。生成的 `dist-one-click` 不得包含 `AGENTS.md`、tests、`functions/`、`node_modules`、开发锁文件或已删除的主题文件。

## Agent 产物

`bin/` 必须整体来自同一次本地 release：

```text
VERSION
SHA256SUMS
nstatus-metrics-linux-amd64
nstatus-metrics-linux-arm64
nstatus-metrics-linux-arm
nstatus-metrics-linux-armv6
nstatus-metrics-linux-386
```

更新步骤：

1. 在私有 Agent 源执行 `./build-release.sh`；
2. 校验六个目标（五个架构二进制 + `VERSION` + `SHA256SUMS`）；
3. 整批复制到 `bin/`；
4. 更新 Linux 安装器的版本与 manifest 哈希；
5. 跑完整测试；
6. 发布 Worker Static Assets。

## 页面功能

公开页展示 Cloudflare 状态、Agent 在线与指标、多来源 Latency、Ping、流量、账单、自动 GeoIP 位置与 IPv4 解锁摘要。后台提供目标管理、商家与自定义商家、机器类型、GeoIP 服务商、固定 Beta 动作、Telegram/邮件、外观、更新、备份与恢复。

主题/插件上传、包运行时与旧卡片主题已移除。内置前端仍支持站点名、Favicon、Logo、页头内容、颜色、文案与区域显隐。

## 安全

- `config.js` 不接受 `?api=` URL 覆盖。
- 静态文件不得包含密码、Session、Agent Token 或生产秘密。
- 后台密码只发送到登录端点；管理 API 使用短期 Session。
- Agent 安装命令含节点专属 Token，禁止公开。
- 动态 HTML 必须转义。
- 安装器必须同时校验 manifest 与二进制。

## 本地测试

```bash
node --test tests/*.test.mjs
node --check app.js
node --check js/admin.js
```

还要在桌面与窄屏移动端检查公开页、NQ 旧报告弹窗、IP 解锁摘要、VPS 详情折叠、图表缩放与后台表单。
