# 安全政策

## 受支持版本

安全修复针对当前 `main` 分支与最新 GitHub Release。上报仅影响旧版本的问题前，请先升级 Worker、前端与 Agent 到同一版本。

## 私密上报

涉及认证、他人部署或私有基础设施的漏洞，不要开公开 Issue。优先使用本仓库的 GitHub Security Advisories；不可用时，通过仓库所有者 GitHub 主页上的私密渠道联系。

上报时附上：受影响的 commit/版本、最小复现、影响与建议修复。移除真实密码、Session、Token、TOTP secret、Telegram/Resend 凭据、Cloudflare ID、域名、IP、Agent 安装命令与生产数据。

## 部署方责任

- `ADMIN_PASSWORD`、Agent Token 与加密密钥使用独立随机值。
- Secret 只放 Wrangler Secrets，不放入 `[vars]`、`.env`、源码、截图或 Issue 日志。
- 管理面启用 TOTP。
- 未配置精确 callback 与显式用户名白名单时，保持 GitHub OAuth 关闭。
- 所有公开 Worker、Pages 与 Agent 端点使用 HTTPS。
- 使用后台为每个目标生成的 scoped Token，不分发全局 Agent Token。
- 校验 GitHub Release 校验和，并在安装命令中固定 manifest 哈希。
- 定期查看 Cloudflare 访问日志、D1/R2 用量与依赖更新。

仓库自带 `tests/public-repo-safety.test.mjs` 检测常见误泄露。它辅助人工审查与 secret 扫描，不能证明部署绝对安全。
