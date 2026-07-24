# 10 安全、隐私和免费额度

## 威胁模型

需要保护：管理员密码和 Session、Agent 主 Token、节点 scoped Token、TOTP secret、Telegram Bot Token、Resend API Key、VPS 地址和历史指标。

主要风险：

- 仓库或日志泄露 Token。
- XSS/恶意扩展读取后台凭据。
- 节点失陷后冒充其他节点。
- 暴力猜测后台账号密码或 TOTP。
- 安装下载被替换。
- 高频指标耗尽 D1/R2/Worker 额度。

## 已采用的控制

- 账号密码与 Token 使用常量时间比较，管理 Session 在 D1 中只保存 SHA-256 哈希。
- 每节点 scoped Token，绑定 Agent ID。
- Admin 可启用 TOTP。
- TOTP secret 使用 AES-GCM 加密。
- TOTP session 在 D1 中保存哈希。
- 后台凭据使用标签页 `sessionStorage`，不长期放 localStorage。
- D1 持久限流。
- 请求体大小限制和字段规范化。
- 公开状态脱敏 IP、端口、URL 凭据。
- 安装器验证 manifest 和二进制 SHA-256，再验证版本。
- Agent 默认要求 HTTPS。
- 扩展上传使用浏览器与 Worker 双端 SHA-256、严格 ZIP/路径/体积校验和失败回滚。
- 可执行扩展在无同源权限的 sandbox iframe 中运行，HTML/SVG 响应另有 CSP 隔离。
- 生产环境不开放服务端远程主题市场，避免未经完整 SSRF 防护的下载入口。

## 部署者必须做的事

1. 使用不同的随机 Secret。
2. 启用 TOTP。
3. 不提交真实 `wrangler.toml` 数据库 ID/私有域名配置到公共模板。
4. 不分享完整 Agent 安装命令。
5. 最小化 GitHub Actions `permissions`。
6. 定期轮换泄露密钥。
7. 使用 Cloudflare 账号 MFA。
8. 审核自定义域名 DNS 和 Pages/Worker 路由。
9. 对管理操作保留日志但不记录 Authorization Header。

## 节点失陷影响

scoped Token 只能以对应 Agent ID 上报，不能直接获得 Admin 权限或其他节点 Token。仍应在节点失陷后重新生成/轮换主 Agent Token或提供节点撤销机制，并检查伪造历史。

## TOTP 的边界

TOTP 保护登录和管理 API，不防止同源 XSS、已控制浏览器、恶意扩展或设备本身失陷。前端仍必须坚持输出转义和依赖审计。

第三方扩展虽然被隔离，仍属于供应链输入。只安装有可审计源码、许可证、版本 tag、显式文件清单和发布 SHA-256 的包；启用前核对后台记录的哈希，不要把管理员密码、Session、Agent Token 或生产数据写入主题配置。完整边界见 [主题、插件与开发者 API](14-extensions-developer-guide.md)。

## 免费额度思路

成本主要来自：

- Worker 请求与 CPU 时间。
- D1 读取/写入和存储。
- R2 Class A/B 操作和存储。
- Durable Object 请求/时长。
- Pages 构建/请求。

系统通过以下方式降成本：

- 当前状态每分钟轻量探测并合并写 R2；SLA 历史固定 5 分钟写 D1，而不是每秒持久化。
- Agent 1 秒采样但批量上传。
- 高频历史进入 R2，不逐点写 D1。
- D1 保存最新状态和聚合。
- 清理任务每小时而不是每次 Cron。
- 状态与检查接口短缓存。

## 规模估算方法

不要只看 VPS 数量。估算：

```text
Agent 上传请求/天 ≈ 节点数 × 86400 / 上报秒数
CF 探测次数/天 ≈ 目标数 × 288
Ping 样本/天 ≈ 节点数 × Ping目标数 × 86400 / Ping秒数
```

例如 50 节点、300 秒上传：约 14,400 次 Agent 上传/天。若每秒直接请求，则会变成 4,320,000 次/天，所以批量设计非常重要。

完整的生产容量表、D1 读写、R2 Class A/B、50 台 5 分钟上传和 200 台 10 分钟上传估算，见主 [README 的 Cloudflare 免费额度与 VPS 容量估算](../../README.zh-CN.md#cloudflare-免费额度与-vps-容量估算)。当前口径下，5 分钟上传的保守理论上限约为 110 台，10 分钟上传在不减少采样点、Ping 点和 72 小时历史的前提下，保守硬上限约为 200 台。

## 调参原则

- 缩短 `NSTATUS_INTERVAL_SEC` 会增加请求量。
- 增加 R2 保留小时会增加存储和读取范围。
- 开启 `AGENT_METRICS_TO_D1` 可能迅速增加 D1 写入。
- 过高 `CONCURRENCY` 可能触发目标网络或 Worker 资源压力。
- 大图表窗口增加 R2 读取和浏览器内存。

上线后在 Cloudflare Dashboard 观察实际用量，不要把估算当保证。
