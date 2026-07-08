# 05 Traffic and Billing

Traffic accounting is per VPS, not global. Each VPS can enable traffic, set a monthly quota, choose a billing mode, and use its expiry day as the reset day.

## Billing Modes

| Mode | Meaning |
| --- | --- |
| total | upload + download |
| tx | upload/outbound only |
| rx | download/inbound only |
| max | larger of upload/download |

## Reset Day

Without an expiry date, traffic resets on the first day of each calendar month. With an expiry date, the reset day follows the day of month of that expiry.

## Special Billing Cases

Hourly cloud instances can leave expiry empty and use the hourly billing cycle. Lifetime or one-time VPS plans can leave expiry empty and use lifetime/onetime billing.

## Accuracy

Traffic is calculated from interface counter deltas and stored in D1. Reboots are handled conservatively, but a small amount of traffic between boot and the first report may not be counted.
