# Cloudflare Free Tier Analysis

The canonical production capacity calculation is maintained in the Chinese root README: [Cloudflare free-tier and VPS capacity estimate](../../README.zh-CN.md#cloudflare-免费额度与-vps-容量估算).

Current assumptions are 1-second local metrics, five 20-second Ping targets per VPS, 72-hour R2 retention, R2-primary history, and D1 history disabled. Under those assumptions:

| Upload interval | Fleet size | Workers requests | D1 rows written | R2 Class A | R2 Class B baseline | R2 storage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 minutes | 50 VPS | ~28.8K/day, 28.8% | ~30K-45K/day, 30%-45% | ~432K/month, 43.2% | ~432K/month, 4.32%+ | ~2.2-2.4 GB-month, 22%-24% |
| 10 minutes | 200 VPS | ~68.4K/day, 68.4% | ~60K-90K/day, 60%-90% | ~864K/month, 86.4% | ~864K/month, 8.64%+ | ~8.8-9.6 GB-month, 88%-96% |

The conservative theoretical ceiling is approximately 110 VPS at a 5-minute upload interval. At a 10-minute upload interval, operation-only math reaches roughly 220 VPS, but five Ping targets and 72-hour raw retention make R2 storage too close to the 10 GB-month free allowance. The documented conservative hard ceiling is therefore 200 VPS, with 150-180 VPS preferred for sustained operation.

Ping samples piggyback on Agent uploads and do not add one Worker request, D1 row write, or R2 Class A operation per sample while `AGENT_PINGS_TO_D1=false`.
