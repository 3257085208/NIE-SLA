# 告警

Worker 每分钟计算一次告警规则。Telegram 与邮件共用相同的阈值、恢复通知、重复提醒冷却与 D1 去重状态。

## 规则

- Agent 离线与恢复。
- Cloudflare 探测失败、中断与恢复。
- CPU、内存、硬盘、Load1。
- 磁盘读写、网络上下行。
- 进程数与线程数。
- VPS 到期日。
- 流量剩余百分比或 GB。

资源阈值填 `0` 表示关闭。每台 VPS 可以单独关闭告警，或覆盖到期与流量阈值。

## Telegram

1. 通过 `@BotFather` 创建 Bot，获取 Token。
2. 把 Bot 加入私聊、群组或频道，获取 Chat ID。
3. 后台“设置 → 报警通知”开启 Telegram，填写 Token 与 Chat ID。
4. 保存后点击“测试 Telegram”。

Token 可以放在 Worker secret `TELEGRAM_BOT_TOKEN`，也可以在后台填写。后台保存时使用长期 `ALERT_ENCRYPTION_KEY`，未单独配置时回退 `TOTP_ENCRYPTION_KEY`。支持纯文本、HTML、MarkdownV2 三种格式，以及群组 Topic、静默发送、链接预览与独立消息模板。

## 电子邮件

邮件通过 Resend HTTPS API 发送，不使用 SMTP 端口：

1. 注册 Resend，验证发件域名，创建 API Key。
2. 后台开启“电子邮件通知”，填写 API Key、发件人与收件人。
3. 保存后点击“测试邮件”。

发件人示例：`NIE-SLA <status@example.com>`。多个收件人用英文逗号分隔，最多 10 个有效地址。API Key 也可以放在 Worker secret `RESEND_API_KEY`，地址用 `ALERT_EMAIL_FROM`、`ALERT_EMAIL_TO`、`ALERT_EMAIL_REPLY_TO` 提供。邮件主题与正文模板独立，正文支持纯文本或 HTML；HTML 模式会转义告警产生的动态内容，管理员自己填写的模板标记保留。

## 模板

Telegram 与邮件使用独立模板。占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{title}}` | 本批通知标题 |
| `{{message}}` | 告警正文或测试正文 |
| `{{site_name}}` | 站点名称 |
| `{{time}}` | 发送时间 |
| `{{alert_count}}` | 本批告警数量 |
| `{{channel}}` | `telegram` 或 `email` |

正文必须包含且只能包含一个 `{{message}}`，其他占位符也只能出现一次；保存时拒绝未知或重复占位符，避免截断 HTML/Markdown 标记或超出长度限制。模板不能执行 JavaScript，也不能修改请求 URL、认证头或收件目标。Telegram 固定请求官方 Bot API，邮件固定请求 Resend API。

## 粒度与去重

Cron 每分钟运行，当前探测结果通过合并后的 R2 状态更新，告警通常约 1 分钟粒度可见。日格、SLA 与长期统计仍按 5 分钟桶写入 D1。关闭 `FAST_STATUS_ENABLED` 后，探测类告警退回 5 分钟持久化检查粒度；Agent 离线告警取决于最近上报时间。

每条规则用 `target_id + rule_key` 保存状态：正常 → 触发 → 活动 → 恢复 → 正常。同一活动告警超过重复提醒冷却时间后才会再发。同时启用两个通道时，Worker 向两通道发送同一批告警，至少一个通道成功即提交去重状态，失败通道记录在最近一次运行结果中。

## 排查

- 测试成功但规则不发：检查阈值、单机开关与冷却时间。
- Telegram 失败：检查 Token、Chat ID 与 Bot 在群组中的权限。
- 邮件失败：检查 Resend 域名验证、API Key 与发件人域名。
- 探测告警慢：确认 `FAST_STATUS_ENABLED=true`，查看 Cron 最近结果。
- Agent 离线告警慢：缩短“离线超过 N 分钟”，但不要低于正常上报抖动范围。

不要在日志、Issue 或截图中公开 Bot Token、Resend API Key、完整安装命令或管理凭据。
