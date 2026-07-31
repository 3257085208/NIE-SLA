# 06 报警通知

Worker 每分钟计算一次报警规则。Telegram 与电子邮件共用相同的阈值、恢复通知、重复提醒冷却和 D1 去重状态。

## 支持的规则

- Agent 离线与恢复。
- Cloudflare 当前探测失败、探测中断与恢复。
- CPU、内存、硬盘、Load1。
- 磁盘读写、网络上下行。
- 进程数和线程数。
- VPS 到期日。
- 流量剩余百分比或 GB。

资源阈值填 `0` 表示关闭该项。每台 VPS 还可以单独关闭报警，或覆盖到期与流量阈值。

## Telegram

1. 在 Telegram 中通过 `@BotFather` 创建 Bot。
2. 获取 Bot Token。
3. 把 Bot 加入私聊、群组或频道。
4. 获取 Chat ID。
5. 打开后台“设置 → 报警通知”。
6. 开启 Telegram，填写 Token 和 Chat ID。
7. 保存后点击“测试 Telegram”。

Bot Token 可以保存在 Worker secret `TELEGRAM_BOT_TOKEN`，也可以在后台填写。后台保存时使用长期 `ALERT_ENCRYPTION_KEY`，未单独配置时使用 `TOTP_ENCRYPTION_KEY`。管理员密码只用于读取旧版本密文；读取成功后系统会用当前长期密钥重新封装。

Telegram 支持纯文本、HTML、MarkdownV2 三种格式，还可以设置群组 Topic / Thread ID、静默发送、链接预览和独立消息模板。

## 电子邮件

邮件通过 Resend HTTPS API 发送，不使用 SMTP 端口。

1. 注册 Resend。
2. 验证自己的发件域名。
3. 创建 Resend API Key。
4. 在后台开启“电子邮件通知”。
5. 填写 API Key、发件人和收件人。
6. 保存后点击“测试邮件”。

发件人示例：

```text
NIE-SLA <status@example.com>
```

多个收件人用英文逗号分隔。最多读取 10 个有效地址。

Resend API Key 也可以使用 Worker secret `RESEND_API_KEY`，并通过 `ALERT_EMAIL_FROM`、`ALERT_EMAIL_TO`、`ALERT_EMAIL_REPLY_TO` 提供地址。后台填写的 API Key 会加密后写入 D1。

邮件可以分别设置主题模板与正文模板，正文支持纯文本或 HTML。HTML 模式会转义报警产生的动态内容，管理员自行填写的模板标记会保留。

## 自定义模板

Telegram 和邮件使用独立模板。可用占位符：

| 占位符 | 内容 |
|---|---|
| `{{title}}` | 本批通知标题 |
| `{{message}}` | 报警正文或测试正文 |
| `{{site_name}}` | 站点名称 |
| `{{time}}` | 发送时间 |
| `{{alert_count}}` | 本批报警数量 |
| `{{channel}}` | `telegram` 或 `email` |

选择 HTML 或 MarkdownV2 时，系统只转义占位符注入的动态值；模板本身的格式标记由管理员控制。保存后应分别发送 Telegram 和邮件测试，确认目标客户端的实际显示。

Telegram 和邮件正文必须包含且只能包含一个 `{{message}}`，其他占位符也只能各出现一次。后台会在保存时拒绝未知或重复的占位符，避免超出 Telegram 长度限制或截断 HTML/Markdown 标记。

模板不能执行 JavaScript，也不能修改请求 URL、认证头或收件目标。Telegram 固定请求官方 Bot API，邮件固定请求 Resend API，避免把后台通知配置变成任意网络请求入口。

## 一分钟当前状态与五分钟 SLA

Worker Cron 每分钟运行。当前探测结果通过合并后的 R2 状态更新，因此报警通常可在约 1 分钟粒度发现变化。日格、SLA 和长期统计仍按 5 分钟桶写入 D1。

若关闭 `FAST_STATUS_ENABLED`，探测类报警会退回 5 分钟持久化检查的粒度；Agent 离线报警仍取决于 Agent 最近上报时间。

## 去重与冷却

每条规则使用 `target_id + rule_key` 保存状态：

```text
正常 → 触发 → 活动 → 恢复 → 正常
```

同一活动报警超过重复提醒冷却时间后才会再次发送。启用恢复通知后，状态恢复时会发送一条恢复消息。

同时启用 Telegram 和邮件时，Worker 会向两个通道发送同一批报警。至少一个通道成功后即提交去重状态，避免正常通道因为另一个通道配置错误而每分钟重复发送；失败通道会记录在最近一次运行结果中。

## 排查

- 测试成功但规则不发：检查阈值、单机报警开关和冷却时间。
- Telegram 失败：检查 Token、Chat ID 和 Bot 在群组中的权限。
- 邮件失败：检查 Resend 域名验证、API Key 和发件人域名。
- 探测报警慢：确认 `FAST_STATUS_ENABLED=true`，并查看 Cron 最近结果。
- Agent 离线报警慢：缩短“离线超过 N 分钟”，但不要低于正常上报抖动范围。

不要在日志、Issue 或截图中公开 Bot Token、Resend API Key、完整安装命令或管理凭据。
