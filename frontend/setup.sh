#!/usr/bin/env bash
set -euo pipefail

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://status.example.com}"
CFTZ_URL_BASE="${CFTZ_URL_BASE:-$DOWNLOAD_BASE}"
DEFAULT_SHA256SUMS_SHA256=""
DEFAULT_EXPECTED_VERSION=""
BIN_NAME="nstatus-metrics"
SERVICE_NAME="nstatus-metrics"
INSTALL_DIR="/usr/local/bin"
WORK_DIR="/opt/nstatus-metrics"
STATE_DIR="/var/lib/nstatus-metrics"
ENV_FILE="$WORK_DIR/nstatus-metrics.env"
CFTZ_BIN="$INSTALL_DIR/cftz"
AGENT_USER="nstatus"
CACHE_KEY="$(printf '%s' "${NSTATUS_SHA256SUMS_SHA256:-$(date +%s)}" | tr -cd 'A-Za-z0-9._-')"
[[ -n "$CACHE_KEY" ]] || CACHE_KEY="$(date +%s)"

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
    err "需要 root 权限，请通过 sudo 运行"
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
  else err "需要安装 curl 或 wget"; exit 1; fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$file" | awk '{print $NF}'
  else err "校验文件需要 sha256sum、shasum 或 openssl"; exit 1; fi
}

verify_binary_checksum() {
  local file="$1" name="$2" sums="$3" expected="${NSTATUS_EXPECTED_SHA256:-}"
  if [[ -z "$expected" ]]; then
    download_to "${DOWNLOAD_BASE%/}/bin/SHA256SUMS?v=${CACHE_KEY}" "$sums"
    local sums_expected="${NSTATUS_SHA256SUMS_SHA256:-$DEFAULT_SHA256SUMS_SHA256}" sums_actual
    sums_actual="$(sha256_file "$sums")"
    if [[ -n "$sums_expected" && "${sums_actual,,}" != "${sums_expected,,}" ]]; then
      err "校验清单验证失败"
      err "expected: $sums_expected"
      err "actual:   $sums_actual"
      exit 1
    fi
    expected="$(awk -v name="${name}" '$2 == name || $2 == "bin/" name { print $1; exit }' "$sums")"
  fi
  if [[ -z "$expected" ]]; then err "校验清单中缺少 ${name}"; exit 1; fi
  local actual
  actual="$(sha256_file "$file")"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    err "${name} 的 SHA-256 不匹配"
    err "expected: $expected"
    err "actual:   $actual"
    exit 1
  fi
  ok "SHA-256 校验通过"
}

verify_agent_version() {
  local file="$1" expected="${NSTATUS_EXPECTED_VERSION:-$DEFAULT_EXPECTED_VERSION}" actual
  actual="$($file --version 2>&1)" || { err "Agent 版本检查失败"; exit 1; }
  if [[ -n "$expected" && "$actual" != *"$expected"* ]]; then
    err "Agent 版本不匹配，期望 $expected，实际 $actual"
    exit 1
  fi
  ok "Agent 版本：$actual"
}

stop_existing_agent() {
  case "$INIT" in
    systemd) systemctl stop "$SERVICE_NAME" 2>/dev/null || true ;;
    openrc) rc-service "$SERVICE_NAME" stop 2>/dev/null || true ;;
  esac
  if command -v pkill >/dev/null 2>&1; then
    pkill -x "$BIN_NAME" 2>/dev/null || true
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

assert_safe_install_paths() {
  local path
  for path in "$WORK_DIR" "$STATE_DIR" "$ENV_FILE" "${WORK_DIR}/${BIN_NAME}"; do
    if [[ -L "$path" ]]; then
      err "拒绝使用符号链接安装路径: $path"
      exit 1
    fi
  done
}

secure_install_permissions() {
  local agent_group
  agent_group="$(id -gn "$AGENT_USER" 2>/dev/null || printf '%s' "$AGENT_USER")"
  mkdir -p "$WORK_DIR" "$STATE_DIR"
  if [[ -f "${WORK_DIR}/samples-queue.json" && ! -e "${STATE_DIR}/samples-queue.json" ]]; then
    mv "${WORK_DIR}/samples-queue.json" "${STATE_DIR}/samples-queue.json"
  fi
  chown root:root "$WORK_DIR" "${WORK_DIR}/${BIN_NAME}"
  chmod 0755 "$WORK_DIR" "${WORK_DIR}/${BIN_NAME}"
  chown "root:${agent_group}" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  chown -R "${AGENT_USER}:${agent_group}" "$STATE_DIR"
  chmod 0750 "$STATE_DIR"
  if [[ -f "$CFTZ_BIN" ]]; then
    chown root:root "$CFTZ_BIN"
    chmod 0755 "$CFTZ_BIN"
  fi
}

write_env_file() {
  local api="$1" token="$2" agent_id="$3" label="$4" interval="$5" ping_targets="$6" ping_sec="$7"
  mkdir -p "$WORK_DIR"
  {
    printf 'NSTATUS_API_BASE=%s\n' "$(shell_quote "$api")"
    printf 'NSTATUS_AGENT_TOKEN=%s\n' "$(shell_quote "$token")"
    printf 'NSTATUS_AGENT_ID=%s\n' "$(shell_quote "$agent_id")"
    printf 'NSTATUS_AGENT_LABEL=%s\n' "$(shell_quote "$label")"
    printf 'NSTATUS_INTERVAL_SEC=%s\n' "$(shell_quote "$interval")"
    printf 'NSTATUS_SAMPLE_SEC=1\n'
    printf 'NSTATUS_QUEUE_FILE=%s\n' "$(shell_quote "${STATE_DIR}/samples-queue.json")"
    printf 'NSTATUS_PRIVILEGED_UPDATER=1\n'
    printf 'NSTATUS_PING_TARGETS=%s\n' "$(shell_quote "$ping_targets")"
    printf 'NSTATUS_PING_SEC=%s\n' "$(shell_quote "$ping_sec")"
  } > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

install_systemd_service() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=聶.NET VPS Metrics Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${STATE_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${WORK_DIR}/${BIN_NAME}
Restart=always
RestartSec=15
User=${AGENT_USER}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STATE_DIR}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/${SERVICE_NAME}-update.service" <<EOF
[Unit]
Description=聶.NET Agent verified update check
After=network-online.target

[Service]
Type=oneshot
ExecStart=${CFTZ_BIN} update --automatic
EOF
  cat > "/etc/systemd/system/${SERVICE_NAME}-update.timer" <<EOF
[Unit]
Description=Check for 聶.NET Agent updates

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl enable --now "${SERVICE_NAME}-update.timer" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
}

install_openrc_service() {
  cat > "/etc/init.d/${SERVICE_NAME}" <<EOF
#!/sbin/openrc-run
name="${SERVICE_NAME}"
description="聶.NET VPS Metrics Agent"

start() {
    ebegin "Starting ${SERVICE_NAME}"
    touch "/var/log/${SERVICE_NAME}.log"
    chown "${AGENT_USER}" "/var/log/${SERVICE_NAME}.log" 2>/dev/null || true
    start-stop-daemon --start --background --make-pidfile \
        --pidfile /run/${SERVICE_NAME}.pid \
        --user ${AGENT_USER} \
        --exec /bin/sh -- \
        -c 'cd "${STATE_DIR}"; set -a; . "${ENV_FILE}"; set +a; exec "${WORK_DIR}/${BIN_NAME}" >>"/var/log/${SERVICE_NAME}.log" 2>&1'
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
  title "卸载 聶.NET Agent"
  case "$(detect_init)" in
    systemd)
      systemctl stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable --now "${SERVICE_NAME}-update.timer" 2>/dev/null || true
      rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
      rm -f "/etc/systemd/system/${SERVICE_NAME}-update.service" "/etc/systemd/system/${SERVICE_NAME}-update.timer"
      systemctl daemon-reload 2>/dev/null || true
      ;;
    openrc)
      rc-service "$SERVICE_NAME" stop 2>/dev/null || true
      rc-update del "$SERVICE_NAME" 2>/dev/null || true
      rm -f "/etc/init.d/${SERVICE_NAME}"
      ;;
  esac
  rm -f "${INSTALL_DIR}/${BIN_NAME}" "$CFTZ_BIN"
  rm -rf "$WORK_DIR" "$STATE_DIR"
  userdel "$AGENT_USER" 2>/dev/null || deluser "$AGENT_USER" 2>/dev/null || true
  ok "已卸载"
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

if [[ "$NON_INTERACTIVE" != "true" ]]; then
  title "聶.NET Agent 配置"
  if [[ -z "$API_BASE" ]]; then read -r -p "API base URL: " API_BASE </dev/tty; fi
  if [[ -z "$TOKEN" ]]; then read -r -s -p "Agent Token：" TOKEN </dev/tty; echo; fi
  if [[ -z "$AGENT_ID" ]]; then read -r -p "Target ID [$(hostname)]: " AGENT_ID </dev/tty; AGENT_ID="${AGENT_ID:-$(hostname)}"; fi
fi

if [[ -z "$API_BASE" ]]; then err "missing NSTATUS_API_BASE or --api"; exit 2; fi
if [[ -z "$TOKEN" ]]; then err "missing NSTATUS_AGENT_TOKEN or --token"; exit 2; fi
if [[ -z "$AGENT_ID" ]]; then AGENT_ID="$(hostname 2>/dev/null || echo vps)"; fi
if [[ -z "$AGENT_LABEL" ]]; then AGENT_LABEL="$AGENT_ID"; fi

API_BASE="${API_BASE%/}"
ARCH="$(detect_arch)"
INIT="$(detect_init)"
BIN_URL="${DOWNLOAD_BASE%/}/bin/${BIN_NAME}-linux-${ARCH}?v=${CACHE_KEY}"
TMPBIN="$(mktemp)"
TMPSUMS="$(mktemp)"
trap 'rm -f "$TMPBIN" "$TMPSUMS"' EXIT INT TERM

title "安装 聶.NET Agent"
info "api: $API_BASE"
info "target: $AGENT_ID"
info "arch: $ARCH"

download_to "$BIN_URL" "$TMPBIN"
verify_binary_checksum "$TMPBIN" "${BIN_NAME}-linux-${ARCH}" "$TMPSUMS"
chmod +x "$TMPBIN"
verify_agent_version "$TMPBIN"
stop_existing_agent
create_user
assert_safe_install_paths
mkdir -p "$WORK_DIR" "$INSTALL_DIR"
install -m 0755 "$TMPBIN" "${WORK_DIR}/${BIN_NAME}" 2>/dev/null || { cp "$TMPBIN" "${WORK_DIR}/${BIN_NAME}"; chmod 0755 "${WORK_DIR}/${BIN_NAME}"; }
ln -sf "${WORK_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"

CFTZ_URL="${CFTZ_URL_BASE%/}/cftz?v=${CACHE_KEY}"
CFTZ_TMP="$(mktemp)"
if download_to "$CFTZ_URL" "$CFTZ_TMP" >/dev/null 2>&1 && [[ -s "$CFTZ_TMP" ]]; then
  install -m 0755 "$CFTZ_TMP" "$CFTZ_BIN" 2>/dev/null || { cp "$CFTZ_TMP" "$CFTZ_BIN"; chmod 0755 "$CFTZ_BIN"; }
fi
rm -f "$CFTZ_TMP"

write_env_file "$API_BASE" "$TOKEN" "$AGENT_ID" "$AGENT_LABEL" "$INTERVAL" "$PING_TARGETS" "$PING_SEC"
secure_install_permissions

case "$INIT" in
  systemd) install_systemd_service; ok "systemd service started"; info "logs: journalctl -u ${SERVICE_NAME} -f" ;;
  openrc) install_openrc_service; ok "OpenRC service started"; info "logs: tail -f /var/log/${SERVICE_NAME}.log" ;;
  *) warn "systemd/OpenRC not detected; starting in background"; set -a; . "$ENV_FILE"; set +a; "${WORK_DIR}/${BIN_NAME}" >/var/log/${SERVICE_NAME}.log 2>&1 & ok "started pid $!" ;;
esac

verify_agent_version "${WORK_DIR}/${BIN_NAME}"

ok "安装完成"
info "uninstall: curl -fsSL ${DOWNLOAD_BASE%/}/install.sh | sudo bash -s -- uninstall"
