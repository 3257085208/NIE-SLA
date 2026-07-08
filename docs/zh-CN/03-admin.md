# 03 后台管理

## 登录与 TOTP

后台地址通常是 `https://your-frontend/admin.html`。首次使用 `ADMIN_TOKEN` 登录后，建议立即在“设置 → TOTP”启用二次验证。TOTP secret 会使用 `TOTP_ENCRYPTION_KEY` 加密后存入 D1。

## 探针字段

- ID：稳定英文 ID，例如 `debian12-vps`，Agent ID 必须与它一致。
- 名称/分组：前端展示。
- 类型：TCP 或 HTTP。
- TCP：主机、端口。
- HTTP：URL、状态码白名单。
- 标签/位置：备注供应商、地区、线路。
- 到期时间、费用、币种、计费周期：用于剩余价值和到期报警。
- 流量统计：每台 VPS 独立开关、额度和计费方式。
- 报警：每台 VPS 可独立关闭，或覆盖到期/流量阈值。

## Ping 管理

Ping 目标由 Agent 侧执行，适合监控 `1.1.1.1:53`、`8.8.8.8:53`、自家 API `api.example.com:443` 等。首页卡片会显示全部 Ping 目标名称和对应颜色小格子。

## 主题

“设置 → 前端样式”可以切换原版列表和卡片风格。卡片风格适合 VPS 展示，原版列表保持传统状态页形态。

## 安装命令

探针列表里的“部署”会生成专属安装命令，包含 API 地址、下载地址、Agent Token、Agent ID 和 Label。不要公开包含 Token 的命令。
