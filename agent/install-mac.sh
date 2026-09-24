#!/usr/bin/env bash
set -euo pipefail

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://status.example.com}"
INSTALL_DIR="/usr/local/bin"
WORK_DIR="/opt/nie-sla-agent"
STATE_DIR="/var/lib/nie-sla-agent"
ENV_FILE="$WORK_DIR/nie-sla-agent.env"
BIN_NAME="nie-sla-agent"
PLIST_LABEL="com.nie-sla.agent"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"
SERVICE_NAME="nie-sla-agent"

ok() { printf '  [OK] %s\n' "$*"; }
err() { printf '  [ERR] %s\n' "$*" >&2; }

[[ $EUID -ne 0 ]] && { err "需要 root 权限"; exit 1; }

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) MAC_ARCH="arm64" ;;
  x86_64) MAC_ARCH="amd64" ;;
  *) err "不支持的架构: $ARCH"; exit 1 ;;
esac

API_BASE="${NIE_SLA_API_BASE:-${NSTATUS_API_BASE:-}}"
TOKEN="${NIE_SLA_AGENT_TOKEN:-${NSTATUS_AGENT_TOKEN:-}}"
AGENT_ID="${NIE_SLA_AGENT_ID:-${NSTATUS_AGENT_ID:-$(hostname)}}"
AGENT_LABEL="${NIE_SLA_AGENT_LABEL:-$AGENT_ID}"

# Must be defined before the argument parser can call it (bash executes the
# script top to bottom; previously `uninstall` failed with command not found).
do_uninstall_mac() {
  launchctl bootout "system/$PLIST_LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  rm -rf "$WORK_DIR" "$STATE_DIR"
  rm -f "$INSTALL_DIR/$BIN_NAME"
  ok "macOS 卸载完成"
  exit 0
}

NON_INTERACTIVE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) NIE_SLA_API_BASE="$2"; shift 2 ;;
    --token|--token=*)
      err "--token 已停用：命令行密钥会留在 ps 与 shell 历史中；请改用 NIE_SLA_AGENT_TOKEN=... 环境变量或交互输入"
      exit 2
      ;;
    --target) NIE_SLA_AGENT_ID="$2"; shift 2 ;;
    --label) NIE_SLA_AGENT_LABEL="$2"; shift 2 ;;
    --non-interactive|-y) NON_INTERACTIVE=true; shift ;;
    uninstall) do_uninstall_mac; exit 0 ;;
    *) shift ;;
  esac
done

if [[ -z "$API_BASE" ]]; then read -r -p "API base URL: " API_BASE </dev/tty; fi
if [[ -z "$TOKEN" ]]; then read -rs -p "Agent Token: " TOKEN </dev/tty; echo; fi
if [[ -z "$AGENT_ID" ]]; then read -r -p "Target ID [$(hostname)]: " AGENT_ID </dev/tty; AGENT_ID="${AGENT_ID:-$(hostname)}"; fi

API_BASE="${API_BASE%/}"

mkdir -p "$WORK_DIR" "$STATE_DIR" "$INSTALL_DIR"

BIN_URL="${DOWNLOAD_BASE}/bin/${BIN_NAME}-macos-${MAC_ARCH}"
TMPBIN="$(mktemp)"
TMPSUMS="$(mktemp)"
trap 'rm -f "$TMPBIN" "$TMPSUMS"' EXIT

curl -fsSL "$BIN_URL" -o "$TMPBIN"
# Verify against the published SHA256SUMS like the Linux installer does;
# previously the checksum was computed and thrown away.
if curl -fsSL "${DOWNLOAD_BASE}/bin/SHA256SUMS" -o "$TMPSUMS" 2>/dev/null; then
  EXPECTED_SHA="$(awk -v name="${BIN_NAME}-macos-${MAC_ARCH}" '$2 == name { print $1 }' "$TMPSUMS" | head -1)"
  ACTUAL_SHA="$(shasum -a 256 "$TMPBIN" | awk '{print $1}')"
  if [[ -z "$EXPECTED_SHA" || "${ACTUAL_SHA,,}" != "${EXPECTED_SHA,,}" ]]; then
    err "Agent 二进制的 SHA-256 校验失败"
    exit 1
  fi
else
  err "无法下载 bin/SHA256SUMS，拒绝安装未校验的二进制"
  exit 1
fi
chmod +x "$TMPBIN"
ACTUAL_VER="$("$TMPBIN" --version 2>&1)" || { err "Agent --version 执行失败"; exit 1; }
[[ "$ACTUAL_VER" == v* ]] || { err "Agent 版本输出异常: $ACTUAL_VER"; exit 1; }

install -m 0755 "$TMPBIN" "${WORK_DIR}/${BIN_NAME}"

cat > "$ENV_FILE" <<ENVEOF
NIE_SLA_API_BASE='$API_BASE'
NIE_SLA_AGENT_TOKEN='$TOKEN'
NIE_SLA_AGENT_ID='$AGENT_ID'
NIE_SLA_AGENT_LABEL='$AGENT_LABEL'
NIE_SLA_QUEUE_FILE='$STATE_DIR/samples-queue.json'
NIE_SLA_SAMPLE_SEC=1
NIE_SLA_INTERVAL_SEC=300
NIE_SLA_WS_ENABLED=1
ENVEOF
chmod 0600 "$ENV_FILE"

cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${WORK_DIR}/${BIN_NAME}</string>
  </array>
  <key>WorkingDirectory</key><string>${STATE_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NIE_SLA_API_BASE</key><string>${API_BASE}</string>
    <key>NIE_SLA_AGENT_TOKEN</key><string>${TOKEN}</string>
    <key>NIE_SLA_AGENT_ID</key><string>${AGENT_ID}</string>
    <key>NIE_SLA_AGENT_LABEL</key><string>${AGENT_LABEL}</string>
    <key>NIE_SLA_QUEUE_FILE</key><string>${STATE_DIR}/samples-queue.json</string>
    <key>NIE_SLA_SAMPLE_SEC</key><string>1</string>
    <key>NIE_SLA_INTERVAL_SEC</key><string>300</string>
    <key>NIE_SLA_WS_ENABLED</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${STATE_DIR}/agent.log</string>
  <key>StandardErrorPath</key><string>${STATE_DIR}/agent.log</string>
</dict>
</plist>
PLISTEOF
# The plist embeds the Agent token; keep it root-only instead of the default
# world-readable mode.
chown root:wheel "$PLIST_PATH"
chmod 0600 "$PLIST_PATH"

launchctl bootstrap system "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH"

sleep 2
if launchctl print "system/$PLIST_LABEL" 2>/dev/null | grep -q "state = running"; then
  ok "macOS Agent 运行正常"
  ok "日志: tail -f ${STATE_DIR}/agent.log"
else
  err "服务未运行，请检查: launchctl print system/${PLIST_LABEL}"
  exit 1
fi
