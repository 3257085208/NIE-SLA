# 部署指南

公开仓库 README 的 **Deploy to Cloudflare** 一键部署：Cloudflare 构建一个 Worker 应用，同时承载静态前端、管理后台、API、Agent 下载、D1、R2、Durable Objects 与每分钟 Cron。不需要单独创建 Pages。

填写 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_PATH` 与 `TOTP_ENCRYPTION_KEY` 后，打开 `Worker 地址 + ADMIN_PATH`。

Agent Token 按节点生成，不要配置共享的 `AGENT_TOKEN`。

## 部署后检查

```bash
curl -fsSL https://你的域名/api/health
curl -fsSL https://你的域名/bin/VERSION
curl -fsSL https://你的域名/bin/SHA256SUMS
```

## 从 Pages + Worker 迁移

复用原 D1、R2、Agent API 域名、节点凭据与加密材料，验证公开页、后台、Cron、Agent 上报与告警后，再把站点域名切到新 Worker。旧 Pages 项目在验收完成前保留。
