# 部署

## 一键部署

1. 打开公开仓库 README，点击 **Deploy to Cloudflare**。
2. 完成 GitHub 与 Cloudflare 授权。
3. 填写后台账号、后台密码、后台路径与独立长期加密密钥。
4. 等待构建完成，打开 Worker 地址。
5. 访问 `https://Worker地址/后台路径`。
6. 登录后新增 VPS，运行该节点生成的 Agent 命令。

一键部署会创建或绑定 Worker Static Assets、D1、R2、Durable Objects 与每分钟 Cron，不需要单独创建 Pages。

必填变量：

| 变量 | 要求 |
| --- | --- |
| `ADMIN_USERNAME` | 3-64 位允许字符 |
| `ADMIN_PASSWORD` | 至少 9 位，包含大小写字母、数字和特殊符号 |
| `ADMIN_PATH` | 3-64 位字母、数字、连字符或下划线，可带前导斜杠 |
| `TOTP_ENCRYPTION_KEY` | 至少 32 位独立随机值，长期不变 |

Agent Token 由后台按节点自动生成，不需要配置全局 `AGENT_TOKEN`。TOTP 默认关闭。长期密钥用于 TOTP、可恢复的每节点 Token 与通知凭据，不要与管理员密码复用。

## 自定义域名

推荐把公开站点域名与旧 Agent API 域名都路由到同一个 Worker。已有 Agent 使用 `api.example.com` 时，迁移必须保持该域名可用，否则要逐台更新 Agent 配置。

## 从 Pages + Worker 迁移

同一 Cloudflare 账号内迁移，优先复用原 D1、R2 与加密密钥：

1. 在旧后台导出普通备份与加密敏感备份。
2. 记录现有 D1、R2、Worker 路由与密钥。
3. 为单 Worker 配置 Static Assets，绑定原 D1、R2。
4. 保持旧 Agent API 域名指向新 Worker。
5. 验证 `/api/health`、公开页、后台、Cron 与 Agent 上报。
6. 再把站点域名从 Pages 切到 Worker。
7. 观察至少一个完整上报周期后再停用 Pages。

复用原 D1 时，已有 Agent ID 与 Token 不变。备份恢复是跨账号或误操作的兜底，不是同账号迁移的首选。

## 更新

后台“系统更新”显示当前版本、最新版本与站内更新日志。部署仓库的 `NIE-SLA Online Update` 工作流可以手动或按计划检查更新，保留部署仓库自己的 `wrangler.jsonc`；如果用户改动了其他源代码，工作流会停止，避免静默覆盖。

## 部署后检查

```bash
curl -fsSL https://你的域名/api/health
curl -fsSL https://你的域名/bin/VERSION
curl -fsSL https://你的域名/bin/SHA256SUMS
```

然后确认：后台能登录且路径正确；新增 VPS 能生成独立安装命令；Agent 显示在线与版本；Cron 每分钟有运行记录；D1 与 R2 用量在免费额度内。
