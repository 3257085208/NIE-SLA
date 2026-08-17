#!/bin/sh
set -eu

NIE_SLA_LATENCY_INSTALL_BASE=${NIE_SLA_LATENCY_INSTALL_BASE:-${NSTATUS_LATENCY_INSTALL_BASE:-}}
NIE_SLA_LATENCY_API_BASE=${NIE_SLA_LATENCY_API_BASE:-${NSTATUS_LATENCY_API_BASE:-}}
NIE_SLA_LATENCY_TOKEN=${NIE_SLA_LATENCY_TOKEN:-${NSTATUS_LATENCY_TOKEN:-}}
NIE_SLA_LATENCY_NODE_ID=${NIE_SLA_LATENCY_NODE_ID:-${NSTATUS_LATENCY_NODE_ID:-}}
NIE_SLA_LATENCY_SCRIPT_SHA256=${NIE_SLA_LATENCY_SCRIPT_SHA256:-${NSTATUS_LATENCY_SCRIPT_SHA256:-}}
export NIE_SLA_LATENCY_INSTALL_BASE NIE_SLA_LATENCY_API_BASE NIE_SLA_LATENCY_TOKEN NIE_SLA_LATENCY_NODE_ID NIE_SLA_LATENCY_SCRIPT_SHA256

: "${NIE_SLA_LATENCY_INSTALL_BASE:?missing NIE_SLA_LATENCY_INSTALL_BASE}"
: "${NIE_SLA_LATENCY_API_BASE:?missing NIE_SLA_LATENCY_API_BASE}"
: "${NIE_SLA_LATENCY_TOKEN:?missing NIE_SLA_LATENCY_TOKEN}"
: "${NIE_SLA_LATENCY_NODE_ID:?missing NIE_SLA_LATENCY_NODE_ID}"
: "${NIE_SLA_LATENCY_SCRIPT_SHA256:?missing NIE_SLA_LATENCY_SCRIPT_SHA256}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run the Latency installer as root." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required to install the Latency agent service." >&2
  exit 1
fi

stop_existing_latency_agent() {
  systemctl disable --now nie-sla-latency-agent.service >/dev/null 2>&1 || true
  systemctl reset-failed nie-sla-latency-agent.service >/dev/null 2>&1 || true
  systemctl disable --now nstatus-latency-agent.service >/dev/null 2>&1 || true
  systemctl reset-failed nstatus-latency-agent.service >/dev/null 2>&1 || true
  if ! command -v pgrep >/dev/null 2>&1; then return; fi

  pgrep -f '/opt/nie-sla-latency/latency-agent.py\|/opt/nstatus-latency/latency-agent.py' | while IFS= read -r pid; do
    kill "$pid" 2>/dev/null || true
  done
  for _attempt in 1 2 3 4 5; do
    if ! pgrep -f '/opt/nie-sla-latency/latency-agent.py\|/opt/nstatus-latency/latency-agent.py' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  pgrep -f '/opt/nie-sla-latency/latency-agent.py\|/opt/nstatus-latency/latency-agent.py' | while IFS= read -r pid; do
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
if ! id nie-sla-latency >/dev/null 2>&1; then
  useradd --system --home-dir /opt/nie-sla-latency --shell /usr/sbin/nologin nie-sla-latency 2>/dev/null \
    || adduser -S -H -h /opt/nie-sla-latency -s /sbin/nologin nie-sla-latency
fi
install -d -m 0750 -o nie-sla-latency -g nie-sla-latency /opt/nie-sla-latency
script_tmp=$(mktemp)
trap 'rm -f "$script_tmp"' EXIT
curl -fsSL "${NIE_SLA_LATENCY_INSTALL_BASE%/}/latency-agent.py?v=6" -o "$script_tmp"
actual_sha256=$(sha256sum "$script_tmp" | awk '{print $1}')
if [ "$actual_sha256" != "$NIE_SLA_LATENCY_SCRIPT_SHA256" ]; then
  echo "Latency agent SHA-256 verification failed." >&2
  exit 1
fi
install -m 0755 -o nie-sla-latency -g nie-sla-latency "$script_tmp" /opt/nie-sla-latency/latency-agent.py

umask 077
cat > /etc/nie-sla-latency-agent.env <<EOF
NIE_SLA_LATENCY_INSTALL_BASE=${NIE_SLA_LATENCY_INSTALL_BASE%/}
NIE_SLA_LATENCY_API_BASE=${NIE_SLA_LATENCY_API_BASE}
NIE_SLA_LATENCY_TOKEN=${NIE_SLA_LATENCY_TOKEN}
NIE_SLA_LATENCY_NODE_ID=${NIE_SLA_LATENCY_NODE_ID}
NIE_SLA_LATENCY_INTERVAL_SEC=${NIE_SLA_LATENCY_INTERVAL_SEC:-${NSTATUS_LATENCY_INTERVAL_SEC:-60}}
NIE_SLA_LATENCY_UPDATE_CHECK_SEC=${NIE_SLA_LATENCY_UPDATE_CHECK_SEC:-${NSTATUS_LATENCY_UPDATE_CHECK_SEC:-3600}}
EOF
chown root:nie-sla-latency /etc/nie-sla-latency-agent.env
chmod 0640 /etc/nie-sla-latency-agent.env

set -a
. /etc/nie-sla-latency-agent.env
set +a
echo "Validating Latency API access and submitting an initial probe..."
/usr/bin/python3 /opt/nie-sla-latency/latency-agent.py --once

cat > /etc/systemd/system/nie-sla-latency-agent.service <<'EOF'
[Unit]
Description=NIE-SLA External Latency Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nie-sla-latency
Group=nie-sla-latency
EnvironmentFile=/etc/nie-sla-latency-agent.env
ExecStart=/usr/bin/python3 /opt/nie-sla-latency/latency-agent.py
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/nie-sla-latency
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nie-sla-latency-agent.service
systemctl start nie-sla-latency-agent.service
if ! systemctl is-active --quiet nie-sla-latency-agent.service; then
  journalctl -u nie-sla-latency-agent.service -n 30 --no-pager >&2 || true
  echo "Latency agent service failed to start." >&2
  exit 1
fi
echo "External Latency Agent installed: ${NIE_SLA_LATENCY_NODE_ID}"
