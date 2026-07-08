# 10 安全与免费额度

## 安全建议

- `ADMIN_TOKEN` 和 `AGENT_TOKEN` 必须足够长。
- 启用 TOTP，保存好 `TOTP_ENCRYPTION_KEY`。
- 不公开后台生成的一键安装命令。
- 保持 `PUBLIC_MASK_IPS=true` 隐藏公开 IP。
- 写接口和后台接口使用 D1 限速，不依赖 Worker 内存限速。
- Chart.js 使用本地 vendor 文件，不从 CDN 动态加载。

## 50 台 VPS 估算

50 台 Agent 每 300 秒上报一次，R2-primary 历史模式下，Worker 请求约 28.8k/天，低于免费 100k/天。D1 主要写最新状态、流量和报警状态，通常明显低于 100k/天。R2 Class A 约 432k/月级别。

## 报警成本

报警主要增加 cron 时的少量 D1 读取和状态写入，只有真正发送消息时才调用 Telegram API，不会让 R2 用量翻倍。

## WebSocket 取舍

WebSocket 可提高实时性，但会增加长连接和 Durable Object 状态管理。当前 HTTP 周期上报更适合免费额度和分钟级离线报警。
