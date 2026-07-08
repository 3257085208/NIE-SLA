#!/usr/bin/env bash
set -euo pipefail

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://your-domain.com}"
CFTZ_URL_BASE="${CFTZ_URL_BASE:-$DOWNLOAD_BASE}"
DEFAULT_SHA256SUMS_SHA256="e9ca6fa4a31f91efaacfc8e3dfcf65c524f1a2e8c5024babc6b67883b46a58be"
BIN_NAME="nstatus-metrics"
SERVICE_NAME="nstatus-metrics"
INSTALL_DIR="/usr/local/bin"
WORK_DIR="/opt/nstatus-metrics"
ENV_FILE="$WORK_DIR/nstatus-metrics.env"
CFTZ_BIN="$INSTALL_DIR/cftz"
AGENT_USER="nstatus"

ok() { printf '  [OK] %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
err() { printf '  [ERR] %s\n' "$*" >&2; }
title() { printf '\n== %s ==\n' "$*"; }

shell_quote() {
  local s="${1-}"
  s=${s//\'/\'"\'"\'}
  printf "'%s'" "$s"
}

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    err "root is required; run through sudo"
    exit 1
  fi
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    i386|i486|i586|i686) echo "386" ;;
    aarch64|arm64) echo "arm64" ;;
    armv5*) echo "armv5" ;;
    armv6*) echo "armv6" ;;
    armv7l|armv7*|armhf) echo "arm" ;;
    *) err "unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
}

detect_init() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then echo "systemd"
  elif command -v rc-service >/dev/null 2>&1; then echo "openrc"
  else echo ""; fi
}

download_to() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then curl -fSL "$url" -o "$out" --progress-bar
  elif command -v wget >/dev/null 2>&1; then wget -q --show-progress "$url" -O "$out"
  else err "curl or wget is required"; exit 1; fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$file" | awk '{print $NF}'
  else err "sha256sum, shasum, or openssl is required for checksum verification"; exit 1; fi
}

verify_binary_checksum() {
  local file="$1" name="$2" sums="$3" expected="${NSTATUS_EXPECTED_SHA256:-}"
  if [[ -z "$expected" ]]; then
    download_to "${DOWNLOAD_BASE%/}/bin/SHA256SUMS" "$sums"
    local sums_expected="${NSTATUS_SHA256SUMS_SHA256:-$DEFAULT_SHA256SUMS_SHA256}" sums_actual
    sums_actual="$(sha256_file "$sums")"
    if [[ "${sums_actual,,}" != "${sums_expected,,}" ]]; then
      err "checksum manifest verification failed"
      err "expected: $sums_expected"
      err "actual:   $sums_actual"
      exit 1
    fi
    expected="$(awk -v name="bin/${name}" '$2 == name { print $1; exit }' "$sums")"
  fi
  if [[ -z "$expected" ]]; then err "missing checksum for ${name}"; exit 1; fi
  local actual
  actual="$(sha256_file "$file")"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    err "checksum mismatch for ${name}"
    err "expected: $expected"
    err "actual:   $actual"
    exit 1
  fi
  ok "checksum verified"
}

install_unlock_deps() {
  local enabled="${NSTATUS_UNLOCK_CHECK_ENABLED:-1}"
  case "${enabled,,}" in 0|false|off) return 0 ;; esac
  local need=0
  for cmd in curl jq bc dig ip; do
    command -v "$cmd" >/dev/null 2>&1 || need=1
  done
  command -v nc >/dev/null 2>&1 || command -v netcat >/dev/null 2>&1 || need=1
  [[ "$need" -eq 0 ]] && return 0
  info "installing unlock check dependencies"
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl jq bc bind-tools iproute2 netcat-openbsd >/dev/null 2>&1 || warn "failed to install some unlock dependencies"
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl jq bc dnsutils iproute2 netcat-openbsd >/dev/null 2>&1 || warn "failed to install some unlock dependencies"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl jq bc bind-utils iproute nmap-ncat >/dev/null 2>&1 || warn "failed to install some unlock dependencies"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl jq bc bind-utils iproute nmap-ncat >/dev/null 2>&1 || warn "failed to install some unlock dependencies"
  else
    warn "package manager not found; install curl jq bc dig nc ip manually for unlock checks"
  fi
}

create_user() {
  if id -u "$AGENT_USER" >/dev/null 2>&1; then return 0; fi
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$AGENT_USER" 2>/dev/null || useradd -r -s /usr/sbin/nologin "$AGENT_USER" 2>/dev/null || true
  elif command -v adduser >/dev/null 2>&1; then
    adduser -S -D -H -s /sbin/nologin "$AGENT_USER" 2>/dev/null || adduser -D -H -s /sbin/nologin "$AGENT_USER" 2>/dev/null || true
  fi
}

write_env_file() {
  local api="$1" token="$2" agent_id="$3" label="$4" interval="$5" ping_targets="$6" ping_sec="$7" unlock_enabled="$8" unlock_sec="$9" unlock_url="${10}" unlock_timeout="${11}"
  mkdir -p "$WORK_DIR"
  {
    printf 'NSTATUS_API_BASE=%s\n' "$(shell_quote "$api")"
    printf 'NSTATUS_AGENT_TOKEN=%s\n' "$(shell_quote "$token")"
    printf 'NSTATUS_AGENT_ID=%s\n' "$(shell_quote "$agent_id")"
    printf 'NSTATUS_AGENT_LABEL=%s\n' "$(shell_quote "$label")"
    printf 'NSTATUS_INTERVAL_SEC=%s\n' "$(shell_quote "$interval")"
    printf 'NSTATUS_SAMPLE_SEC=1\n'
    printf 'NSTATUS_PING_TARGETS=%s\n' "$(shell_quote "$ping_targets")"
    printf 'NSTATUS_PING_SEC=%s\n' "$(shell_quote "$ping_sec")"
    printf 'NSTATUS_UNLOCK_CHECK_ENABLED=%s\n' "$(shell_quote "$unlock_enabled")"
    printf 'NSTATUS_UNLOCK_CHECK_SEC=%s\n' "$(shell_quote "$unlock_sec")"
    printf 'NSTATUS_UNLOCK_CHECK_URL=%s\n' "$(shell_quote "$unlock_url")"
    printf 'NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC=%s\n' "$(shell_quote "$unlock_timeout")"
  } > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

install_systemd_service() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=NStatus VPS Metrics Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${WORK_DIR}
ExecStart=/bin/sh -c 'set -a; . "${ENV_FILE}"; set +a; exec "${WORK_DIR}/${BIN_NAME}"'
Restart=always
RestartSec=15
User=${AGENT_USER}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${WORK_DIR}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
}

install_openrc_service() {
  cat > "/etc/init.d/${SERVICE_NAME}" <<EOF
#!/sbin/openrc-run
name="${SERVICE_NAME}"
description="NStatus VPS Metrics Agent"

start() {
    ebegin "Starting ${SERVICE_NAME}"
    touch "/var/log/${SERVICE_NAME}.log"
    chown "${AGENT_USER}" "/var/log/${SERVICE_NAME}.log" 2>/dev/null || true
    start-stop-daemon --start --background --make-pidfile \
        --pidfile /run/${SERVICE_NAME}.pid \
        --user ${AGENT_USER} \
        --exec /bin/sh -- \
        -c 'set -a; . "${ENV_FILE}"; set +a; exec "${WORK_DIR}/${BIN_NAME}" >>"/var/log/${SERVICE_NAME}.log" 2>&1'
    eend \$?
}

stop() {
    ebegin "Stopping ${SERVICE_NAME}"
    start-stop-daemon --stop --pidfile /run/${SERVICE_NAME}.pid
    eend \$?
}

depend() { need net; }
EOF
  chmod +x "/etc/init.d/${SERVICE_NAME}"
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-service "$SERVICE_NAME" restart
}

do_uninstall() {
  need_root
  title "Uninstall NStatus Agent"
  case "$(detect_init)" in
    systemd)
      systemctl stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable "$SERVICE_NAME" 2>/dev/null || true
      rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
      systemctl daemon-reload 2>/dev/null || true
      ;;
    openrc)
      rc-service "$SERVICE_NAME" stop 2>/dev/null || true
      rc-update del "$SERVICE_NAME" 2>/dev/null || true
      rm -f "/etc/init.d/${SERVICE_NAME}"
      ;;
  esac
  rm -f "${INSTALL_DIR}/${BIN_NAME}" "$CFTZ_BIN"
  rm -rf "$WORK_DIR"
  userdel "$AGENT_USER" 2>/dev/null || deluser "$AGENT_USER" 2>/dev/null || true
  ok "removed"
}

NON_INTERACTIVE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    uninstall) do_uninstall; exit 0 ;;
    --api) NSTATUS_API_BASE="$2"; shift 2 ;;
    --token) NSTATUS_AGENT_TOKEN="$2"; shift 2 ;;
    --target) NSTATUS_AGENT_ID="$2"; shift 2 ;;
    --label) NSTATUS_AGENT_LABEL="$2"; shift 2 ;;
    --interval) NSTATUS_INTERVAL_SEC="$2"; shift 2 ;;
    --ping-targets) NSTATUS_PING_TARGETS="$2"; shift 2 ;;
    --ping-sec) NSTATUS_PING_SEC="$2"; shift 2 ;;
    --unlock-check-enabled) NSTATUS_UNLOCK_CHECK_ENABLED="$2"; shift 2 ;;
    --unlock-check-sec) NSTATUS_UNLOCK_CHECK_SEC="$2"; shift 2 ;;
    --unlock-check-url) NSTATUS_UNLOCK_CHECK_URL="$2"; shift 2 ;;
    --unlock-check-timeout) NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC="$2"; shift 2 ;;
    --no-unlock-check) NSTATUS_UNLOCK_CHECK_ENABLED="0"; shift ;;
    --non-interactive|-y) NON_INTERACTIVE=true; shift ;;
    *) shift ;;
  esac
done

need_root

API_BASE="${NSTATUS_API_BASE:-}"
TOKEN="${NSTATUS_AGENT_TOKEN:-}"
AGENT_ID="${NSTATUS_AGENT_ID:-}"
AGENT_LABEL="${NSTATUS_AGENT_LABEL:-}"
INTERVAL="${NSTATUS_INTERVAL_SEC:-300}"
PING_TARGETS="${NSTATUS_PING_TARGETS:-*}"
PING_SEC="${NSTATUS_PING_SEC:-20}"
UNLOCK_CHECK_ENABLED="${NSTATUS_UNLOCK_CHECK_ENABLED:-1}"
UNLOCK_CHECK_SEC="${NSTATUS_UNLOCK_CHECK_SEC:-300}"
UNLOCK_CHECK_URL="${NSTATUS_UNLOCK_CHECK_URL:-https://IP.Check.Place}"
UNLOCK_CHECK_TIMEOUT="${NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC:-90}"

if [[ "$NON_INTERACTIVE" != "true" ]]; then
  title "NStatus Agent setup"
  if [[ -z "$API_BASE" ]]; then read -r -p "API base URL: " API_BASE </dev/tty; fi
  if [[ -z "$TOKEN" ]]; then read -r -s -p "Agent token: " TOKEN </dev/tty; echo; fi
  if [[ -z "$AGENT_ID" ]]; then read -r -p "Target ID [$(hostname)]: " AGENT_ID </dev/tty; AGENT_ID="${AGENT_ID:-$(hostname)}"; fi
fi

if [[ -z "$API_BASE" ]]; then err "missing NSTATUS_API_BASE or --api"; exit 2; fi
if [[ -z "$TOKEN" ]]; then err "missing NSTATUS_AGENT_TOKEN or --token"; exit 2; fi
if [[ -z "$AGENT_ID" ]]; then AGENT_ID="$(hostname 2>/dev/null || echo vps)"; fi
if [[ -z "$AGENT_LABEL" ]]; then AGENT_LABEL="$AGENT_ID"; fi

API_BASE="${API_BASE%/}"
ARCH="$(detect_arch)"
INIT="$(detect_init)"
BIN_URL="${DOWNLOAD_BASE%/}/bin/${BIN_NAME}-linux-${ARCH}"
TMPBIN="$(mktemp)"
TMPSUMS="$(mktemp)"
trap 'rm -f "$TMPBIN" "$TMPSUMS"' EXIT INT TERM

title "Install NStatus Agent"
info "api: $API_BASE"
info "target: $AGENT_ID"
info "arch: $ARCH"

download_to "$BIN_URL" "$TMPBIN"
verify_binary_checksum "$TMPBIN" "${BIN_NAME}-linux-${ARCH}" "$TMPSUMS"
chmod +x "$TMPBIN"
install_unlock_deps
create_user
mkdir -p "$WORK_DIR" "$INSTALL_DIR"
install -m 0755 "$TMPBIN" "${WORK_DIR}/${BIN_NAME}" 2>/dev/null || { cp "$TMPBIN" "${WORK_DIR}/${BIN_NAME}"; chmod 0755 "${WORK_DIR}/${BIN_NAME}"; }
ln -sf "${WORK_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"

CFTZ_URL="${CFTZ_URL_BASE%/}/cftz"
CFTZ_TMP="$(mktemp)"
if download_to "$CFTZ_URL" "$CFTZ_TMP" >/dev/null 2>&1 && [[ -s "$CFTZ_TMP" ]]; then
  install -m 0755 "$CFTZ_TMP" "$CFTZ_BIN" 2>/dev/null || { cp "$CFTZ_TMP" "$CFTZ_BIN"; chmod 0755 "$CFTZ_BIN"; }
fi
rm -f "$CFTZ_TMP"

write_env_file "$API_BASE" "$TOKEN" "$AGENT_ID" "$AGENT_LABEL" "$INTERVAL" "$PING_TARGETS" "$PING_SEC" "$UNLOCK_CHECK_ENABLED" "$UNLOCK_CHECK_SEC" "$UNLOCK_CHECK_URL" "$UNLOCK_CHECK_TIMEOUT"
chown -R "$AGENT_USER" "$WORK_DIR" 2>/dev/null || true

case "$INIT" in
  systemd) install_systemd_service; ok "systemd service started"; info "logs: journalctl -u ${SERVICE_NAME} -f" ;;
  openrc) install_openrc_service; ok "OpenRC service started"; info "logs: tail -f /var/log/${SERVICE_NAME}.log" ;;
  *) warn "systemd/OpenRC not detected; starting in background"; set -a; . "$ENV_FILE"; set +a; "${WORK_DIR}/${BIN_NAME}" >/var/log/${SERVICE_NAME}.log 2>&1 & ok "started pid $!" ;;
esac

ok "installed"
info "uninstall: curl -fsSL ${DOWNLOAD_BASE%/}/install.sh | sudo bash -s -- uninstall"
