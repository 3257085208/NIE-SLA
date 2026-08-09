# Traffic and billing

Traffic and billing settings belong to each VPS, not the whole deployment.

## Data source

Agents report cumulative NIC received/transmitted bytes and instantaneous rates. The Worker computes deltas between consecutive cumulative values; the page and alerts merge the persisted D1 period row with the not-yet-persisted counter difference, so the display stays current at the 5-minute reporting cadence. Period rows persist at most every 30 minutes and immediately on day rollover, counter reset, or period change; the first persist after rollover seals the previous day into the daily ledger. Restarts, counter wraps, or NIC changes never subtract negative deltas:

```text
delta = max(0, current_cumulative - last_cumulative)
```

## Enabling

1. Edit the target.
2. Enable traffic accounting.
3. Set the quota in GB; `0` means unlimited.
4. Set the monthly reset day (1-31).
5. Pick the accounting mode.
6. Save and wait for the next Agent report.

## Accounting modes

| Mode | Formula |
| --- | --- |
| Both directions | `rx + tx` |
| Download only | `rx` |
| Upload only | `tx` |
| Larger direction | `max(rx, tx)` |

Choose per the provider's billing rules.

## Period reset

The reset day is independent of expiry. With `1`, periods follow calendar months; with `24`, the period runs from the 24th of the month to the 24th of the next. Days 29-31 fall back to the last day of shorter months. Expiry only drives expiry display and alerts.

Changing the reset day switches the current period immediately: the Worker recomputes sealed daily traffic inside the new period and adds today's unsealed traffic. Values may grow or shrink because the covered dates changed.

## Billing fields

`price`, `currency` (USD, CNY, ...), `billing_cycle` (monthly, yearly, one-time, hourly, ...), `expires_at`, `traffic_reset_day`, `location`, and `tags`. Exchange-rate display is an estimate, not a billing basis.

## Precision and limits

- Accuracy depends on the reporting interval; packets are not written per event.
- Multiple reports on the same day only update the current period row; one daily ledger row per agent per day is typical.
- Changing the reset day reads roughly one month of daily records.
- Traffic is not recorded while the Agent is offline; catch-up depends on counter continuity.
- OS reinstalls or NIC resets break the cumulative baseline.
- Container/veth virtual NICs can double-count; verify the Agent's interface selection.
- The page total = persisted D1 value + latest counter difference; the instant rate shown in the frontend is not period traffic.

## Alerts

Supports remaining percent and remaining GB; percent only makes sense with a quota set. A single VPS can override the global traffic thresholds.

## Troubleshooting

Zero traffic: check Agent online state, traffic enabled, cumulative fields present in the latest report, period, and mode. Do not reset by deleting D1 rows unless you know the current period key and the consequences.
