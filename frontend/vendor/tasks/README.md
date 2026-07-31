# Reviewed task source snapshots

This directory contains unmodified source snapshots used by NIE-SLA's fixed
NodeQuality and IP unlock actions. They are distributed separately from the
NIE-SLA application under the GNU Affero General Public License v3.0.

`manifest.json` records the reviewed upstream commit and SHA-256 for each
snapshot. The Agent downloads only these same-origin assets and verifies the
hard-coded digest before execution. At runtime the Agent may apply the
NodeQuality result-capture hook implemented in its public Rust source.

The upstream scripts can download additional tools and datasets. Those
secondary downloads are not covered by the entrypoint digest, so NIE-SLA runs
the task under a dedicated unprivileged host account and Linux namespaces.
Failure to establish that boundary aborts the task.

The upstream projects are not affiliated with and do not endorse NIE-SLA.
Their corresponding license text is included in `AGPL-3.0.txt`.
