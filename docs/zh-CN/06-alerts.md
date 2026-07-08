# 06 Telegram 报警

## 工作方式

报警由 Worker cron 定时检查，不使用 WebSocket。默认 5 分钟一轮，适合离线/上线和资源阈值提醒，同时避免长连接和 Durable Object 额度复杂度。

## 配置步骤

1. 用 `@BotFather` 创建 Bot。
2. 获取 Bot Token。
3. 获取用户、群或频道的 Chat ID。
4. 后台“设置 → Telegram 报警”填入 Token 和 Chat ID；后台保存的 Bot Token 会加密后写入 D1，也可以改用 Worker secret `TELEGRAM_BOT_TOKEN`。
5. 点击“测试 TG”。

## 支持的报警

- 离线超过 N 分钟。
- 恢复上线提醒。
- CPU、内存、硬盘、Load1。
- 磁盘读写 MB/s、上下行 MB/s。
- 进程数、线程数。
- 到期前 N 天。
- 流量剩余低于 N% 或 N GB。

## 单台 VPS 覆盖

探针编辑窗口可以关闭该 VPS 报警，也可以单独覆盖到期和流量阈值。留空表示使用全局设置。

## 状态与冷却

D1 表 `alert_state` 记录每个目标每条规则的 active/resolved 状态。未恢复前按冷却时间重复提醒，恢复后清除状态并可发送上线消息。
