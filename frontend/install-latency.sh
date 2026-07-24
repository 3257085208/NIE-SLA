#!/bin/sh
set -eu

: "${NSTATUS_LATENCY_INSTALL_BASE:?missing NSTATUS_LATENCY_INSTALL_BASE}"
: "${NSTATUS_LATENCY_API_BASE:?missing NSTATUS_LATENCY_API_BASE}"
: "${NSTATUS_LATENCY_TOKEN:?missing NSTATUS_LATENCY_TOKEN}"
: "${NSTATUS_LATENCY_NODE_ID:?missing NSTATUS_LATENCY_NODE_ID}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run the Latency installer as root." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required to install the Latency agent service." >&2
  exit 1
fi

stop_existing_latency_agent() {
  systemctl disable --now nstatus-latency-agent.service >/dev/null 2>&1 || true
  systemctl reset-failed nstatus-latency-agent.service >/dev/null 2>&1 || true
  if ! command -v pgrep >/dev/null 2>&1; then return; fi

  pgrep -f '/opt/nstatus-latency/latency-agent.py' | while IFS= read -r pid; do
    kill "$pid" 2>/dev/null || true
  done
  for _attempt in 1 2 3 4 5; do
    if ! pgrep -f '/opt/nstatus-latency/latency-agent.py' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  pgrep -f '/opt/nstatus-latency/latency-agent.py' | while IFS= read -r pid; do
    kill -9 "$pid" 2>/dev/null || true
  done
}

if ! command -v python3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq python3
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache python3
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q python3
  elif command -v yum >/dev/null 2>&1; then yum install -y -q python3
  else echo "Python 3 is required." >&2; exit 1; fi
fi

stop_existing_latency_agent
install -d -m 0755 /opt/nstatus-latency
curl -fsSL "${NSTATUS_LATENCY_INSTALL_BASE%/}/latency-agent.py?v=4" -o /opt/nstatus-latency/latency-agent.py
chmod 0755 /opt/nstatus-latency/latency-agent.py

umask 077
cat > /etc/nstatus-latency-agent.env <<EOF
NSTATUS_LATENCY_INSTALL_BASE=${NSTATUS_LATENCY_INSTALL_BASE%/}
NSTATUS_LATENCY_API_BASE=${NSTATUS_LATENCY_API_BASE}
NSTATUS_LATENCY_TOKEN=${NSTATUS_LATENCY_TOKEN}
NSTATUS_LATENCY_NODE_ID=${NSTATUS_LATENCY_NODE_ID}
NSTATUS_LATENCY_INTERVAL_SEC=${NSTATUS_LATENCY_INTERVAL_SEC:-60}
NSTATUS_LATENCY_UPDATE_CHECK_SEC=${NSTATUS_LATENCY_UPDATE_CHECK_SEC:-3600}
EOF
chmod 0600 /etc/nstatus-latency-agent.env

set -a
. /etc/nstatus-latency-agent.env
set +a
echo "Validating Latency API access and submitting an initial probe..."
/usr/bin/python3 /opt/nstatus-latency/latency-agent.py --once

cat > /etc/systemd/system/nstatus-latency-agent.service <<'EOF'
[Unit]
Description=NIE-SLA External Latency Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/nstatus-latency-agent.env
ExecStart=/usr/bin/python3 /opt/nstatus-latency/latency-agent.py
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/nstatus-latency
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nstatus-latency-agent.service
systemctl start nstatus-latency-agent.service
if ! systemctl is-active --quiet nstatus-latency-agent.service; then
  journalctl -u nstatus-latency-agent.service -n 30 --no-pager >&2 || true
  echo "Latency agent service failed to start." >&2
  exit 1
fi
echo "External Latency Agent installed: ${NSTATUS_LATENCY_NODE_ID}"
