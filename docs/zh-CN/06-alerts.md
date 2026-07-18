# 06 Telegram 报警

报警由 Worker 在定时任务或后台手动检查时计算，不由 Agent 直接向 Telegram 发消息。

## 创建 Bot

1. 在 Telegram 与 `@BotFather` 对话。
2. 创建 Bot 并得到 Bot Token。
3. 将 Bot 加入目标私聊/群组/频道。
4. 获取 Chat ID。
5. 在后台“设置 → Telegram 报警”填写并发送测试消息。

Bot Token 是 secret。后台保存时使用 `ALERT_ENCRYPTION_KEY` 加密；也可以优先通过 Worker secret `TELEGRAM_BOT_TOKEN` 配置。

## 支持的规则

- Agent 离线超过 N 分钟。
- Agent 恢复在线。
- CF 探测持续失败/恢复。
- CPU、内存、硬盘百分比。
- Load1。
- 磁盘读写 MB/s。
- 网络上下行 MB/s。
- 进程数、线程数。
- VPS 即将到期。
- 流量剩余百分比或 GB。

资源阈值 `0` 表示关闭该项。

## 状态机

每条规则按 `target_id + rule_key` 保存活动状态：

```text
正常 -> 触发 -> 活动告警 -> 恢复 -> 正常
```

活动期间不会每 5 分钟无限刷屏；超过 repeat cooldown 才重复提醒。开启“恢复通知”后，活动状态解除时发送恢复消息。

## 单机覆盖

编辑 VPS 可以：

- 完全关闭该目标报警。
- 覆盖到期天数。
- 覆盖流量百分比/GB。

未填写覆盖时使用全局设置。

## 离线与探测失败

Agent 离线看最后指标时间；CF 失败看外部探测。对于有 Agent 的 VPS，两种报警应分别理解，避免因 IPv6 CF 不可达误报“机器关机”。

## 测试

1. 保存设置。
2. 点击“测试 TG”，验证凭据和 Chat ID。
3. 点击“立即检查”，验证规则执行。
4. 查看返回的 `sent` 和 `errors`。

测试消息成功但规则不发，通常是阈值未达到、单机关闭或 cooldown 未结束。

## 安全

- 不把 Bot Token 写入仓库。
- 群组 Chat ID 可视为敏感配置。
- 定期轮换泄露的 Bot Token。
- 限制 Bot 在群组中的权限。
- 报警消息不要包含完整 Agent Token、URL 查询凭据或未掩码 IP。
