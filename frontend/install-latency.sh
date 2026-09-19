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

SERVICE_NAME=nie-sla-latency-agent
RUN_SCRIPT=/opt/nie-sla-latency/run.sh
LOG_FILE=/var/log/nie-sla-latency-agent.log

INIT_SYSTEM=""
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  INIT_SYSTEM=systemd
elif [ -d /etc/init.d ] && command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
  INIT_SYSTEM=openrc
else
  echo "systemd or OpenRC is required to install the Latency agent service." >&2
  exit 1
fi

stop_existing_latency_agent() {
  if [ "$INIT_SYSTEM" = systemd ]; then
    systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    systemctl reset-failed "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    systemctl disable --now nstatus-latency-agent.service >/dev/null 2>&1 || true
    systemctl reset-failed nstatus-latency-agent.service >/dev/null 2>&1 || true
  else
    rc-service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
    rc-update del "$SERVICE_NAME" default >/dev/null 2>&1 || true
    rc-service nstatus-latency-agent stop >/dev/null 2>&1 || true
    rc-update del nstatus-latency-agent default >/dev/null 2>&1 || true
    rm -f "/etc/init.d/$SERVICE_NAME" /etc/init.d/nstatus-latency-agent
  fi
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
# BusyBox adduser on Alpine does not always create the same-named group, and
# the env file is chowned to root:nie-sla-latency so the service user can read
# it. Create the group explicitly before the user on every init system.
if ! grep -q '^nie-sla-latency:' /etc/group 2>/dev/null; then
  groupadd --system nie-sla-latency 2>/dev/null || addgroup -S nie-sla-latency 2>/dev/null || addgroup nie-sla-latency 2>/dev/null || true
fi
if ! id nie-sla-latency >/dev/null 2>&1; then
  useradd --system --gid nie-sla-latency --home-dir /opt/nie-sla-latency --shell /usr/sbin/nologin nie-sla-latency 2>/dev/null \
    || adduser -S -H -G nie-sla-latency -h /opt/nie-sla-latency -s /sbin/nologin nie-sla-latency
fi
install -d -m 0750 /opt/nie-sla-latency
chown nie-sla-latency:nie-sla-latency /opt/nie-sla-latency 2>/dev/null || true
script_tmp=$(mktemp)
trap 'rm -f "$script_tmp"' EXIT
curl -fsSL "${NIE_SLA_LATENCY_INSTALL_BASE%/}/latency-agent.py?v=6" -o "$script_tmp"
actual_sha256=$(sha256sum "$script_tmp" | awk '{print $1}')
if [ "$actual_sha256" != "$NIE_SLA_LATENCY_SCRIPT_SHA256" ]; then
  echo "Latency agent SHA-256 verification failed." >&2
  exit 1
fi
install -m 0755 "$script_tmp" /opt/nie-sla-latency/latency-agent.py
chown nie-sla-latency:nie-sla-latency /opt/nie-sla-latency/latency-agent.py 2>/dev/null || true

umask 077
cat > /etc/nie-sla-latency-agent.env <<EOF
NIE_SLA_LATENCY_INSTALL_BASE=${NIE_SLA_LATENCY_INSTALL_BASE%/}
NIE_SLA_LATENCY_API_BASE=${NIE_SLA_LATENCY_API_BASE}
NIE_SLA_LATENCY_TOKEN=${NIE_SLA_LATENCY_TOKEN}
NIE_SLA_LATENCY_NODE_ID=${NIE_SLA_LATENCY_NODE_ID}
NIE_SLA_LATENCY_INTERVAL_SEC=${NIE_SLA_LATENCY_INTERVAL_SEC:-${NSTATUS_LATENCY_INTERVAL_SEC:-60}}
NIE_SLA_LATENCY_UPDATE_CHECK_SEC=${NIE_SLA_LATENCY_UPDATE_CHECK_SEC:-${NSTATUS_LATENCY_UPDATE_CHECK_SEC:-3600}}
EOF
chown root:nie-sla-latency /etc/nie-sla-latency-agent.env 2>/dev/null \
  || chown root:"$(id -gn nie-sla-latency 2>/dev/null || echo root)" /etc/nie-sla-latency-agent.env
chmod 0640 /etc/nie-sla-latency-agent.env

cat > "$RUN_SCRIPT" <<'EOF'
#!/bin/sh
set -eu
set -a
. /etc/nie-sla-latency-agent.env
set +a
exec /usr/bin/python3 /opt/nie-sla-latency/latency-agent.py
EOF
chmod 0755 "$RUN_SCRIPT"

set -a
. /etc/nie-sla-latency-agent.env
set +a
echo "Validating Latency API access and submitting an initial probe..."
/usr/bin/python3 /opt/nie-sla-latency/latency-agent.py --once

if [ "$INIT_SYSTEM" = systemd ]; then
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<'EOF'
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
else
  if command -v supervise-daemon >/dev/null 2>&1; then
    supervisor_block='supervisor="supervise-daemon"
respawn_delay=5'
    background_block=""
  else
    supervisor_block=""
    background_block='command_background="yes"'
  fi
  cat > "/etc/init.d/${SERVICE_NAME}" <<EOF
#!/sbin/openrc-run
name="${SERVICE_NAME}"
description="NIE-SLA External Latency Agent"

command="/opt/nie-sla-latency/run.sh"
command_user="nie-sla-latency:nie-sla-latency"
${background_block}
pidfile="/run/${SERVICE_NAME}.pid"
output_log="${LOG_FILE}"
error_log="${LOG_FILE}"
${supervisor_block}

start_pre() {
    touch "${LOG_FILE}"
    chown "nie-sla-latency" "${LOG_FILE}" 2>/dev/null || true
}

depend() { need net; }
EOF
  chmod 0755 "/etc/init.d/${SERVICE_NAME}"
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-service "$SERVICE_NAME" restart >/dev/null 2>&1 || rc-service "$SERVICE_NAME" start >/dev/null 2>&1 || true

  # OpenRC without supervise-daemon does not respawn a crashed process; add a
  # bounded periodic watchdog that starts the service again if it is gone.
  if [ -d /etc/periodic/15min ]; then
    cat > "/etc/periodic/15min/${SERVICE_NAME}" <<'EOF'
#!/bin/sh
if rc-service nie-sla-latency-agent status >/dev/null 2>&1; then
  exit 0
fi
rc-service nie-sla-latency-agent start >/dev/null 2>&1 || true
EOF
    chmod 0755 "/etc/periodic/15min/${SERVICE_NAME}"
    if [ -x /etc/init.d/crond ]; then
      rc-update add crond default >/dev/null 2>&1 || true
      rc-service crond start >/dev/null 2>&1 || true
    elif [ -x /etc/init.d/cron ]; then
      rc-update add cron default >/dev/null 2>&1 || true
      rc-service cron start >/dev/null 2>&1 || true
    fi
  fi

  sleep 2
  if ! rc-service "$SERVICE_NAME" status >/dev/null 2>&1; then
    tail -n 30 "$LOG_FILE" >&2 || true
    echo "Latency agent service failed to start." >&2
    exit 1
  fi
fi
echo "External Latency Agent installed: ${NIE_SLA_LATENCY_NODE_ID}"
