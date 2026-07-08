# 02 Cloudflare 部署

## 前置要求

- Cloudflare 账号。
- Node.js 18+。
- Wrangler CLI，可直接使用 `npx wrangler`。
- 自定义域名可选，没有域名也能使用 `workers.dev` / `pages.dev`。

## 脚本部署

```bash
cd worker
bash deploy.sh
```

脚本会创建或复用 D1、R2，写入 `ADMIN_TOKEN`、`AGENT_TOKEN`、`TOTP_ENCRYPTION_KEY`，生成 `wrangler.toml`，部署 Worker，并部署 Pages 前端。

## 手动部署 Worker

```bash
cd worker
npx wrangler d1 create nstatus-db
npx wrangler r2 bucket create nstatus-archive
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler deploy
```

把 D1 输出的 `database_id` 写入 `worker/wrangler.toml`。

## 手动部署 Pages

```bash
cd frontend
cat > config.js <<'EOF'
window.NSTATUS_API_BASE = 'https://your-worker.example.workers.dev';
EOF
npx wrangler pages deploy ./ --project-name=nstatus
```

## 域名建议

- Worker API：`https://nstatus-api.example.com`
- Pages 前端：`https://status.example.com`
- Agent 下载地址：建议使用 Pages 前端域名

跨域时设置：

```toml
ALLOWED_ORIGIN = "https://status.example.com"
PUBLIC_WORKER_URL = "https://nstatus-api.example.com"
PUBLIC_AGENT_INSTALL_BASE = "https://status.example.com"
```

## 首次验证

```bash
curl https://your-worker.example.com/
```

应返回包含 `"ok":true` 的 JSON。然后打开 `https://your-frontend/admin.html` 用 `ADMIN_TOKEN` 登录。
