# Python external agent is legacy

Prefer the Rust agent (`nstatus-metrics`) for all new installs.

`agent_orangepi.py` remains for compatibility only. It now initializes
`interval` before the network call so a first-request failure no longer
crash-loops systemd via UnboundLocalError.
