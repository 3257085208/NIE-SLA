# Cloudflare 一键部署

## 新用户

1. 点击公开仓库 README 顶部的 **Deploy to Cloudflare**。
2. 完成 GitHub 与 Cloudflare 授权。
3. 填写后台账号、后台密码、后台路径和独立长期加密密钥。
4. 等待构建完成，打开 Worker 地址。
5. 访问 `https://Worker地址/后台路径`。
6. 登录后在“探针”新增 VPS，并运行该节点生成的 Agent 命令。

一键部署会创建或绑定 Worker Static Assets、D1、R2、Durable Objects 和每分钟 Cron。无需再创建 Pages。

### 必填项

| 变量 | 要求 |
| --- | --- |
| `ADMIN_USERNAME` | 3-64 位允许字符 |
| `ADMIN_PASSWORD` | 至少 9 位，包含大小写字母、数字和特殊符号 |
| `ADMIN_PATH` | 3-64 位字母、数字、连字符或下划线，可带前导斜杠 |
| `TOTP_ENCRYPTION_KEY` | 至少 32 位独立随机值；修改管理员密码时不要同步更换 |

Agent Token 由后台按节点自动生成。TOTP 默认关闭。长期密钥用于TOTP、可恢复Agent Token和通知凭据，不应与管理员密码复用。

## 自定义域名

推荐将公开站点域名与旧 Agent API 域名都路由到同一个 Worker。若已有 Agent 使用 `api.example.com`，迁移时必须保持该域名可用，或者逐台更新 Agent 配置。

## 从 Pages + Worker 迁移

同 Cloudflare 账号迁移优先复用原 D1、R2 和加密密钥：

1. 在旧后台导出普通备份和加密敏感备份。
2. 记录现有 D1、R2、Worker 路由和密钥。
3. 为单 Worker 配置 Static Assets，并绑定原 D1、R2。
4. 保持旧 Agent API 域名指向新 Worker。
5. 验证 `/api/health`、公开页、后台、Cron 和 Agent 上报。
6. 再把站点域名从 Pages 切到 Worker。
7. 观察至少一个完整上报周期后再停用 Pages。

复用原 D1 时，已有 Agent ID 与 Token 保持不变。备份恢复是跨账号或误操作兜底，不是同账号迁移的首选。

## 更新

后台“系统更新”显示版本和站内更新日志。部署仓库的 `NIE-SLA Online Update` 工作流可以无参数手动运行，也可按计划检查更新。

更新会保留部署仓库自己的 `wrangler.jsonc`。如果用户修改了其他源代码，工作流会停止，避免静默覆盖。

## 部署后检查

```bash
curl -fsSL https://你的域名/api/health
curl -fsSL https://你的域名/bin/VERSION
curl -fsSL https://你的域名/bin/SHA256SUMS
```

然后检查：

- 后台账号密码能登录；
- 后台路径正确，旧通用入口返回 404；
- 新增 VPS 能生成独立安装命令；
- Agent 在后台显示最近上报；
- Cron 每分钟有运行记录；
- D1 与 R2 绑定可用；
- Telegram/邮件测试通知按需成功。
