# Cloudflare Free Tier Analysis

## R2-primary storage mode

High-frequency Agent history now uses R2 by default:

- `agent_metrics_state` stays in D1 for the latest VPS state and admin metadata.
- 1-second VPS samples are written to hourly R2 objects.
- TCP Ping samples are written to the same hourly R2 objects.
- D1 history tables are fallback-only unless `AGENT_METRICS_TO_D1=true` or `AGENT_PINGS_TO_D1=true`.
- D1-backed rate limiting is enabled by default for authenticated/write routes when the `DB` binding is present. Public cached reads keep a best-effort in-isolate throttle to avoid extra D1 load.

## 50 VPS + 1-second metrics

Assumptions:

- 50 Agents.
- `NSTATUS_SAMPLE_SEC=1`.
- `NSTATUS_INTERVAL_SEC=300`.
- R2 retention: `AGENT_METRICS_R2_RETENTION_HOURS=72`.
- No public dashboard traffic included.

| Resource | Daily Usage | Monthly | Free Limit | % |
|----------|-------------|---------|------------|---|
| Workers Requests | ~28.8K | ~864K | 100K/day | 28.8% |
| D1 Writes | ~30K-45K | ~0.9M-1.35M | 100K/day | 30%-45% |
| D1 Storage | tiny, latest state only | — | 5GB | <1% |
| R2 Class A | ~14.4K | ~432K | 1M/month | 43.2% |
| R2 Class B | ~14.4K + chart reads | ~432K + chart reads | 10M/month | ~4.3%+ |
| R2 Storage | ~2.1GB retained | — | 10GB-month | ~21% |

## TCP Ping impact

Ping no longer consumes D1 write quota by default.

Example with 50 Agents, 1 Ping target, `NSTATUS_PING_SEC=20`:

| Resource | Usage | Notes |
|----------|-------|-------|
| Ping samples | 216K/day | Stored in R2 hourly objects |
| Extra D1 writes | 0/day | Unless `AGENT_PINGS_TO_D1=true` |
| Extra R2 Class A | 0/month | Piggybacks on the normal 5-minute Agent upload |
| Extra R2 storage | modest | Appended inside the existing hourly JSON |

## Practical conclusion

50 VPS is safe on the free tier in R2-primary mode. The closest regular quotas are D1 writes and R2 Class A writes, both still below half of the free daily/monthly allowance before dashboard/admin reads. Keep high-frequency history in R2 and avoid enabling `AGENT_PINGS_TO_D1` for large fleets.
