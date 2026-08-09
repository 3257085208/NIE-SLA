# 免费额度测算

权威测算在 `docs/zh-CN/10-security-free-tier.md`。

结论：100 台 VPS、每 5 分钟上报，理论上落在 Cloudflare 免费额度内，D1 写入行是最紧的指标；200 台/10 分钟上报会超出 Workers/D1/R2 免费额度。上线后在 Dashboard 监控 Workers、Durable Objects、D1 rows 与 R2 操作，任一指标接近 80% 时降低上报频率或切换 Workers Paid。
