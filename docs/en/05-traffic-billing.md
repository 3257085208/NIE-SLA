# 05 Traffic and Billing

Traffic accounting is per VPS, not global. Each VPS can enable traffic, set a monthly quota, choose a billing mode, and configure an independent monthly reset day from 1 to 31. Counter deltas accumulate in the active period row, and the first report after a day boundary finalizes one daily ledger row.

## Billing Modes

| Mode | Meaning |
| --- | --- |
| total | upload + download |
| tx | upload/outbound only |
| rx | download/inbound only |
| max | larger of upload/download |

## Reset Day

The traffic reset day is independent of the VPS expiry date. Day 1 uses calendar months; day 24 creates periods from the 24th to the next 24th. Days 29–31 use the last valid day in shorter months. Extending or changing the expiry date does not change this period.

Changing the reset day switches the active period immediately. The Worker rebuilds the total from finalized daily rows in the new date range and includes the active, not-yet-finalized day. It preserves the raw counter baseline. The displayed total may increase or decrease because the new period includes a different set of dates.

## Special Billing Cases

Hourly cloud instances can leave expiry empty and use the hourly billing cycle. Lifetime or one-time VPS plans can leave expiry empty and use lifetime/onetime billing.

## Accuracy

Traffic is calculated from interface counter deltas. API responses and alerts combine the persisted period row with the latest unflushed counter delta, so visible totals still follow every five-minute Agent report. The D1 period row is persisted at most every 30 minutes and immediately at day, counter-reset, or billing-period boundaries. Reboots are handled conservatively, but a small amount of traffic between boot and the first report may not be counted. Each Agent normally adds only one daily row per day, and reset-day changes read roughly one period of daily rows.
