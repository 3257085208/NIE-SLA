#!/usr/bin/env bash
set -euo pipefail

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://status.example.com}"
CFTZ_URL_BASE="${CFTZ_URL_BASE:-$DOWNLOAD_BASE}"

# ---------- 品牌横幅：仅交互终端输出；环境变量 NIE_SLA_BANNER=nie-sla|qq.sg|as218834 选择品牌 ----------
print_brand_banner() {
    local suffix="${1:-}"
    if [ ! -t 1 ] || [ -n "${NO_COLOR:-}" ]; then return 0; fi
    local esc reset bold dim NEU pad
    esc='\033['
    reset='\033[0m'
    bold='\033[1;37m'
    dim='\033[2m'
    NEU="${esc}38;5;245m"
    printf '\n'
    printf '%b\n' "${esc}38;5;245m╔═══════════════════════════════════════════════════════╦═══════════════════════════════════════════════════════╗${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;51m█${esc}38;5;22m▓    ${esc}38;5;51m█${esc}38;5;22m▓ ${esc}38;5;51m█████${esc}38;5;22m▓ ${esc}38;5;51m██████${esc}38;5;22m▓        ${esc}38;5;51m██████${esc}38;5;22m▓ ${esc}38;5;51m█${esc}38;5;22m▓       ${esc}38;5;51m█████${esc}38;5;22m▓ ${reset}${esc}38;5;245m║${reset} ${esc}38;5;213m██████${esc}38;5;53m▓   ${esc}38;5;213m██████${esc}38;5;53m▓       ${esc}38;5;213m██████${esc}38;5;53m▓  ${esc}38;5;213m██████${esc}38;5;53m▓              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;50m██${esc}38;5;22m▓   ${esc}38;5;50m█${esc}38;5;22m▓ ${esc}38;5;22m▓▓${esc}38;5;50m█${esc}38;5;22m▓▓  ${esc}38;5;50m█${esc}38;5;22m▓▓▓▓▓         ${esc}38;5;50m█${esc}38;5;22m▓▓▓▓▓  ${esc}38;5;50m█${esc}38;5;22m▓      ${esc}38;5;50m█${esc}38;5;22m▓▓▓▓▓${esc}38;5;50m█${esc}38;5;22m▓${reset}${esc}38;5;245m║${reset}${esc}38;5;207m██${esc}38;5;53m▓▓▓▓${esc}38;5;207m██${esc}38;5;53m▓ ${esc}38;5;207m██${esc}38;5;53m▓▓▓▓${esc}38;5;207m██${esc}38;5;53m▓      ${esc}38;5;207m█${esc}38;5;53m▓▓▓▓▓  ${esc}38;5;207m██${esc}38;5;53m▓▓▓▓▓               ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;49m█${esc}38;5;22m▓${esc}38;5;49m█${esc}38;5;22m▓  ${esc}38;5;49m█${esc}38;5;22m▓   ${esc}38;5;49m█${esc}38;5;22m▓   ${esc}38;5;49m█${esc}38;5;22m▓             ${esc}38;5;49m██████${esc}38;5;22m▓ ${esc}38;5;49m█${esc}38;5;22m▓      ${esc}38;5;49m███████${esc}38;5;22m▓${reset}${esc}38;5;245m║${reset}${esc}38;5;201m██${esc}38;5;53m▓   ${esc}38;5;201m██${esc}38;5;53m▓ ${esc}38;5;201m██${esc}38;5;53m▓   ${esc}38;5;201m██${esc}38;5;53m▓      ${esc}38;5;201m██████${esc}38;5;53m▓ ${esc}38;5;201m██${esc}38;5;53m▓  ${esc}38;5;201m███${esc}38;5;53m▓             ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;48m█${esc}38;5;22m▓▓${esc}38;5;48m█${esc}38;5;22m▓ ${esc}38;5;48m█${esc}38;5;22m▓   ${esc}38;5;48m█${esc}38;5;22m▓   ${esc}38;5;48m█████${esc}38;5;22m▓  ${esc}38;5;48m█████${esc}38;5;22m▓ ${esc}38;5;22m▓▓▓▓▓${esc}38;5;48m█${esc}38;5;22m▓ ${esc}38;5;48m█${esc}38;5;22m▓      ${esc}38;5;48m█${esc}38;5;22m▓▓▓▓▓${esc}38;5;48m█${esc}38;5;22m▓${reset}${esc}38;5;245m║${reset}${esc}38;5;176m██${esc}38;5;53m▓   ${esc}38;5;176m██${esc}38;5;53m▓ ${esc}38;5;176m██${esc}38;5;53m▓   ${esc}38;5;176m██${esc}38;5;53m▓      ${esc}38;5;53m▓▓▓▓▓${esc}38;5;176m█${esc}38;5;53m▓ ${esc}38;5;176m██${esc}38;5;53m▓  ${esc}38;5;53m▓${esc}38;5;176m██${esc}38;5;53m▓             ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;47m█${esc}38;5;22m▓ ${esc}38;5;22m▓${esc}38;5;47m█${esc}38;5;22m▓${esc}38;5;47m█${esc}38;5;22m▓   ${esc}38;5;47m█${esc}38;5;22m▓   ${esc}38;5;47m█${esc}38;5;22m▓▓▓▓   ${esc}38;5;22m▓▓▓▓▓  ${esc}38;5;47m██████${esc}38;5;22m▓ ${esc}38;5;47m█${esc}38;5;22m▓      ${esc}38;5;47m█${esc}38;5;22m▓    ${esc}38;5;47m█${esc}38;5;22m▓${reset}${esc}38;5;245m║${reset}${esc}38;5;171m██${esc}38;5;53m▓   ${esc}38;5;171m██${esc}38;5;53m▓ ${esc}38;5;171m██${esc}38;5;53m▓   ${esc}38;5;171m██${esc}38;5;53m▓  ${esc}38;5;171m█${esc}38;5;53m▓  ${esc}38;5;171m██████${esc}38;5;53m▓ ${esc}38;5;171m██${esc}38;5;53m▓   ${esc}38;5;171m██${esc}38;5;53m▓             ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;46m█${esc}38;5;22m▓  ${esc}38;5;22m▓${esc}38;5;46m██${esc}38;5;22m▓ ${esc}38;5;46m█████${esc}38;5;22m▓ ${esc}38;5;46m██████${esc}38;5;22m▓        ${esc}38;5;22m▓▓▓▓▓${esc}38;5;46m█${esc}38;5;22m▓ ${esc}38;5;46m██████${esc}38;5;22m▓ ${esc}38;5;46m█${esc}38;5;22m▓    ${esc}38;5;46m█${esc}38;5;22m▓${reset}${esc}38;5;245m║${reset}${esc}38;5;53m▓${esc}38;5;165m███████${esc}38;5;53m▓ ${esc}38;5;53m▓${esc}38;5;165m███████${esc}38;5;53m▓ ${esc}38;5;165m███${esc}38;5;53m▓ ${esc}38;5;53m▓▓▓▓▓${esc}38;5;165m█${esc}38;5;53m▓ ${esc}38;5;53m▓${esc}38;5;165m██████${esc}38;5;53m▓              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;22m▓    ${esc}38;5;22m▓▓  ${esc}38;5;22m▓▓▓▓▓  ${esc}38;5;22m▓▓▓▓▓▓              ${esc}38;5;22m▓  ${esc}38;5;22m▓▓▓▓▓▓  ${esc}38;5;22m▓     ${esc}38;5;22m▓ ${reset}${esc}38;5;245m║${reset} ${esc}38;5;53m▓▓▓▓▓▓▓   ${esc}38;5;53m▓▓▓▓▓▓▓  ${esc}38;5;53m▓▓▓       ${esc}38;5;53m▓   ${esc}38;5;53m▓▓▓▓▓▓               ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}1;37m                        NIE-SLA                        ${reset}${esc}38;5;245m║${reset}${esc}1;37m                         QQ.SG                         ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m╠═══════════════════════════════════════════════════════╬═══════════════════════════════════════════════════════╣${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset} ${esc}38;5;220m█████${esc}38;5;52m▓  ${esc}38;5;220m██████${esc}38;5;52m▓ ${esc}38;5;220m██████${esc}38;5;52m▓    ${esc}38;5;220m█${esc}38;5;52m▓   ${esc}38;5;220m██████${esc}38;5;52m▓ ${esc}38;5;220m██████${esc}38;5;52m▓ ${esc}38;5;220m██████${esc}38;5;52m▓ ${esc}38;5;220m█${esc}38;5;52m▓    ${esc}38;5;220m█${esc}38;5;52m▓                                              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;214m█${esc}38;5;52m▓▓▓▓▓${esc}38;5;214m█${esc}38;5;52m▓ ${esc}38;5;214m█${esc}38;5;52m▓▓▓▓▓  ${esc}38;5;52m▓▓▓▓▓${esc}38;5;214m██${esc}38;5;52m▓  ${esc}38;5;214m██${esc}38;5;52m▓   ${esc}38;5;214m█${esc}38;5;52m▓▓▓▓${esc}38;5;214m█${esc}38;5;52m▓ ${esc}38;5;214m█${esc}38;5;52m▓▓▓▓${esc}38;5;214m█${esc}38;5;52m▓ ${esc}38;5;52m▓▓▓▓▓${esc}38;5;214m█${esc}38;5;52m▓ ${esc}38;5;214m█${esc}38;5;52m▓    ${esc}38;5;214m█${esc}38;5;52m▓                                              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;208m███████${esc}38;5;52m▓ ${esc}38;5;208m██████${esc}38;5;52m▓   ${esc}38;5;208m███${esc}38;5;52m▓▓  ${esc}38;5;208m█████${esc}38;5;52m▓ ${esc}38;5;208m██████${esc}38;5;52m▓ ${esc}38;5;208m██████${esc}38;5;52m▓ ${esc}38;5;208m██████${esc}38;5;52m▓ ${esc}38;5;208m█${esc}38;5;52m▓    ${esc}38;5;208m█${esc}38;5;52m▓                                              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;202m█${esc}38;5;52m▓▓▓▓▓${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;52m▓▓▓▓▓${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;202m██${esc}38;5;52m▓▓▓    ${esc}38;5;52m▓▓${esc}38;5;202m█${esc}38;5;52m▓▓  ${esc}38;5;202m█${esc}38;5;52m▓▓▓▓${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;202m█${esc}38;5;52m▓▓▓▓${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;52m▓▓▓▓▓${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;202m███████${esc}38;5;52m▓                                              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;196m█${esc}38;5;52m▓    ${esc}38;5;196m█${esc}38;5;52m▓ ${esc}38;5;196m██████${esc}38;5;52m▓ ${esc}38;5;196m██${esc}38;5;52m▓        ${esc}38;5;196m█${esc}38;5;52m▓   ${esc}38;5;196m█${esc}38;5;52m▓   ${esc}38;5;196m█${esc}38;5;52m▓ ${esc}38;5;196m█${esc}38;5;52m▓   ${esc}38;5;196m█${esc}38;5;52m▓      ${esc}38;5;196m█${esc}38;5;52m▓ ${esc}38;5;52m▓▓▓▓▓▓${esc}38;5;196m█${esc}38;5;52m▓                                              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;202m█${esc}38;5;52m▓    ${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;52m▓▓▓▓▓${esc}38;5;202m█${esc}38;5;52m▓ ${esc}38;5;202m██████${esc}38;5;52m▓  ${esc}38;5;202m█████${esc}38;5;52m▓ ${esc}38;5;202m██████${esc}38;5;52m▓ ${esc}38;5;202m██████${esc}38;5;52m▓ ${esc}38;5;202m██████${esc}38;5;52m▓       ${esc}38;5;202m█${esc}38;5;52m▓                                              ${reset}${esc}38;5;245m║${reset}"
    printf '%b\n' "${esc}38;5;245m║${reset}${esc}38;5;52m▓     ${esc}38;5;52m▓       ${esc}38;5;52m▓  ${esc}38;5;52m▓▓▓▓▓▓   ${esc}38;5;52m▓▓▓▓▓  ${esc}38;5;52m▓▓▓▓▓▓  ${esc}38;5;52m▓▓▓▓▓▓  ${esc}38;5;52m▓▓▓▓▓▓        ${esc}38;5;52m▓                                               ${reset}${esc}38;5;245m║${reset}"
    pad=$(( 111 - 12 - ${#suffix} ))
    (( pad < 0 )) && pad=0
    printf '%b║%b AS218834 · %b%s%*s%b%b║%b\n' "${NEU}" "${bold}" "${dim}" "${suffix}" "$pad" "" "${reset}" "${NEU}" "${reset}"
    printf '%b\n' "${esc}38;5;245m╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════════╝${reset}"
    printf '\n'
}

DEFAULT_SHA256SUMS_SHA256=""
DEFAULT_CFTZ_SHA256="49a0a476bc9260e6e3b5631abf7c5dd537e8cf141657cb93358f68c4fc363256"
DEFAULT_EXPECTED_VERSION=""
BIN_NAME="nie-sla-agent"
SERVICE_NAME="nie-sla-agent"
TASK_SERVICE_NAME="nie-sla-agent-manager"
INSTALL_DIR="/usr/local/bin"
WORK_DIR="/opt/nie-sla-agent"
STATE_DIR="/var/lib/nie-sla-agent"
MANAGER_STATE_DIR="/var/lib/nie-sla-agent-manager"
ENV_FILE="$WORK_DIR/nie-sla-agent.env"
CFTZ_BIN="$INSTALL_DIR/cftz"
AGENT_USER="nie-sla"
LEGACY_SERVICE_NAME="nstatus-metrics"
LEGACY_TASK_SERVICE_NAME="nstatus-metrics-tasks"
LEGACY_WORK_DIR="/opt/nstatus-metrics"
LEGACY_STATE_DIR="/var/lib/nstatus-metrics"
LEGACY_MANAGER_STATE_DIR="/var/lib/nstatus-manager"
LEGACY_TASK_USER="nstatus-task"
ROOTLESS_MODE=false
case "${NIE_SLA_ROOTLESS:-${NSTATUS_ROOTLESS:-}}" in 1|true|TRUE|yes|YES) ROOTLESS_MODE=true ;; esac

if [[ "$ROOTLESS_MODE" == "true" ]]; then
  INSTALL_DIR="${HOME}/.local/bin"
  WORK_DIR="${HOME}/nie-sla-agent"
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/nie-sla-agent"
  MANAGER_STATE_DIR="$STATE_DIR"
  ENV_FILE="$WORK_DIR/nie-sla-agent.env"
  CFTZ_BIN="$INSTALL_DIR/cftz"
fi

CACHE_KEY="$(printf '%s' "${NIE_SLA_SHA256SUMS_SHA256:-${NSTATUS_SHA256SUMS_SHA256:-$(date +%s)}}" | tr -cd 'A-Za-z0-9._-')"
[[ -n "$CACHE_KEY" ]] || CACHE_KEY="$(date +%s)"
INSTALL_STARTED_AT="$(date +%s)"
HEALTH_CHECK_TIMEOUT_SEC="${NIE_SLA_INSTALL_HEALTH_TIMEOUT_SEC:-${NSTATUS_INSTALL_HEALTH_TIMEOUT_SEC:-75}}"
case "$HEALTH_CHECK_TIMEOUT_SEC" in ''|*[!0-9]*) HEALTH_CHECK_TIMEOUT_SEC=75 ;; esac
if (( HEALTH_CHECK_TIMEOUT_SEC < 10 || HEALTH_CHECK_TIMEOUT_SEC > 300 )); then HEALTH_CHECK_TIMEOUT_SEC=75; fi

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
  local file="$1" name="$2" sums="$3" expected="${NIE_SLA_EXPECTED_SHA256:-${NSTATUS_EXPECTED_SHA256:-}}"
  if [[ -z "$expected" ]]; then
    download_to "${DOWNLOAD_BASE%/}/bin/SHA256SUMS?v=${CACHE_KEY}" "$sums"
    local sums_expected="${NIE_SLA_SHA256SUMS_SHA256:-${NSTATUS_SHA256SUMS_SHA256:-$DEFAULT_SHA256SUMS_SHA256}}" sums_actual
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
  local file="$1" expected="${NIE_SLA_EXPECTED_VERSION:-${NSTATUS_EXPECTED_VERSION:-$DEFAULT_EXPECTED_VERSION}}" actual
  actual="$($file --version 2>&1)" || { err "Agent 版本检查失败"; exit 1; }
  if [[ -n "$expected" && "$actual" != *"$expected"* ]]; then
    err "Agent 版本不匹配，期望 $expected，实际 $actual"
    exit 1
  fi
  ok "Agent 版本：$actual"
}

stop_existing_agent() {
  case "$INIT" in
    systemd)
      systemctl disable --now "$LEGACY_SERVICE_NAME" "$LEGACY_TASK_SERVICE_NAME" "${LEGACY_SERVICE_NAME}-update.timer" 2>/dev/null || true
      systemctl stop "$SERVICE_NAME" "$TASK_SERVICE_NAME" 2>/dev/null || true
      ;;
    openrc)
      rc-service "$LEGACY_SERVICE_NAME" stop 2>/dev/null || true
      rc-service "$LEGACY_TASK_SERVICE_NAME" stop 2>/dev/null || true
      rc-update del "$LEGACY_SERVICE_NAME" default 2>/dev/null || true
      rc-update del "$LEGACY_TASK_SERVICE_NAME" default 2>/dev/null || true
      rc-service "$SERVICE_NAME" stop 2>/dev/null || true
      rc-service "$TASK_SERVICE_NAME" stop 2>/dev/null || true
      ;;
  esac
  if command -v pkill >/dev/null 2>&1; then
    pkill -x "$BIN_NAME" 2>/dev/null || true
    pkill -x "$LEGACY_SERVICE_NAME" 2>/dev/null || true
  fi
}

create_system_user() {
  local user="$1" shell_path uid gid
  if ! id -u "$user" >/dev/null 2>&1; then
    shell_path="$(command -v nologin 2>/dev/null || true)"
    [[ -x "$shell_path" ]] || shell_path="/bin/false"
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --no-create-home --shell "$shell_path" "$user" 2>/dev/null \
        || useradd -r -M -s "$shell_path" "$user" 2>/dev/null \
        || true
    elif command -v adduser >/dev/null 2>&1; then
      adduser --system --no-create-home --shell "$shell_path" "$user" 2>/dev/null \
        || adduser -S -D -H -s "$shell_path" "$user" 2>/dev/null \
        || adduser -D -H -s "$shell_path" "$user" 2>/dev/null \
        || true
    fi
  fi
  uid="$(id -u "$user" 2>/dev/null || true)"
  gid="$(id -g "$user" 2>/dev/null || true)"
  if [[ ! "$uid" =~ ^[0-9]+$ || "$uid" == "0" || ! "$gid" =~ ^[0-9]+$ || "$gid" == "0" ]]; then
    err "无法创建非 root 系统用户: $user"
    exit 1
  fi
}

create_users() {
  create_system_user "$AGENT_USER"
}

migrate_legacy_state() {
  mkdir -p "$STATE_DIR" "$MANAGER_STATE_DIR"
  if [[ -d "$LEGACY_STATE_DIR" && ! -L "$LEGACY_STATE_DIR" ]]; then
    for name in samples-queue.json; do
      if [[ -f "${LEGACY_STATE_DIR}/${name}" && ! -L "${LEGACY_STATE_DIR}/${name}" && ! -e "${STATE_DIR}/${name}" ]]; then
        cp -p "${LEGACY_STATE_DIR}/${name}" "${STATE_DIR}/${name}"
      fi
    done
  fi
  if [[ -d "$LEGACY_MANAGER_STATE_DIR" && ! -L "$LEGACY_MANAGER_STATE_DIR" ]]; then
    if [[ -f "${LEGACY_MANAGER_STATE_DIR}/update-confirmed" && ! -L "${LEGACY_MANAGER_STATE_DIR}/update-confirmed" && ! -e "${MANAGER_STATE_DIR}/update-confirmed" ]]; then
      cp -p "${LEGACY_MANAGER_STATE_DIR}/update-confirmed" "${MANAGER_STATE_DIR}/update-confirmed"
    fi
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
  mkdir -p "$WORK_DIR" "$STATE_DIR" "$MANAGER_STATE_DIR"
  if [[ -f "${WORK_DIR}/samples-queue.json" && ! -e "${STATE_DIR}/samples-queue.json" ]]; then
    mv "${WORK_DIR}/samples-queue.json" "${STATE_DIR}/samples-queue.json"
  fi
  chown root:root "$WORK_DIR" "${WORK_DIR}/${BIN_NAME}"
  chmod 0755 "$WORK_DIR" "${WORK_DIR}/${BIN_NAME}"
  chown "root:${agent_group}" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  chown -R "${AGENT_USER}:${agent_group}" "$STATE_DIR"
  chmod 0750 "$STATE_DIR"
  chown -R root:root "$MANAGER_STATE_DIR"
  chmod 0755 "$MANAGER_STATE_DIR"
  if [[ -f "$CFTZ_BIN" ]]; then
    chown root:root "$CFTZ_BIN"
    chmod 0755 "$CFTZ_BIN"
  fi
}

write_env_file() {
  local api="$1" token="$2" agent_id="$3" label="$4" interval="$5" ping_targets="$6" ping_sec="$7"
  mkdir -p "$WORK_DIR"
  {
    printf 'NIE_SLA_API_BASE=%s\n' "$(shell_quote "$api")"
    printf 'NIE_SLA_AGENT_TOKEN=%s\n' "$(shell_quote "$token")"
    printf 'NIE_SLA_AGENT_ID=%s\n' "$(shell_quote "$agent_id")"
    printf 'NIE_SLA_AGENT_LABEL=%s\n' "$(shell_quote "$label")"
    printf 'NIE_SLA_INTERVAL_SEC=%s\n' "$(shell_quote "$interval")"
    printf 'NIE_SLA_SAMPLE_SEC=1\n'
    printf 'NIE_SLA_QUEUE_FILE=%s\n' "$(shell_quote "${STATE_DIR}/samples-queue.json")"
    printf 'NIE_SLA_PRIVILEGED_UPDATER=1\n'
    printf 'NIE_SLA_PING_TARGETS=%s\n' "$(shell_quote "$ping_targets")"
    printf 'NIE_SLA_PING_SEC=%s\n' "$(shell_quote "$ping_sec")"
  } > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

install_rootless_service() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir" "$STATE_DIR"
  cat > "$unit_dir/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=NIE-SLA VPS Metrics Agent (rootless)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${STATE_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${WORK_DIR}/${BIN_NAME}
Restart=on-failure
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
  if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
    systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl --user restart "$SERVICE_NAME"
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
      if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || true
      else
        warn "未启用 linger：用户注销后 Agent 会停止；启用：sudo loginctl enable-linger $USER"
      fi
    fi
  else
    warn "systemd user 会话不可用；改为后台启动（重启后需手动拉起或改用完整版安装）"
    set -a; . "$ENV_FILE"; set +a
    ( cd "$STATE_DIR" && nohup "$WORK_DIR/$BIN_NAME" >> "$STATE_DIR/${SERVICE_NAME}.log" 2>&1 & )
  fi
}

install_systemd_service() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=NIE-SLA VPS Metrics Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${STATE_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${WORK_DIR}/${BIN_NAME}
Restart=on-failure
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
  cat > "/etc/systemd/system/${TASK_SERVICE_NAME}.service" <<EOF
[Unit]
Description=NIE-SLA privileged Agent manager
After=network-online.target ${SERVICE_NAME}.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${STATE_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NIE_SLA_TASK_RUNNER_ONLY=1
ExecStart=${WORK_DIR}/${BIN_NAME} --task-runner-only
Restart=on-failure
RestartSec=20
User=root
PrivateTmp=true
ProtectHome=true
UMask=0027
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/${SERVICE_NAME}-update.service" <<EOF
[Unit]
Description=NIE-SLA Agent privileged recovery update
After=network-online.target

[Service]
Type=oneshot
ExecCondition=/bin/sh -c '! systemctl is-active --quiet ${TASK_SERVICE_NAME}'
ExecStart=${CFTZ_BIN} update --automatic
EOF
  cat > "/etc/systemd/system/${SERVICE_NAME}-update.timer" <<EOF
[Unit]
Description=Recover NIE-SLA Agent manager and verified updates

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
  systemctl enable "$TASK_SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl enable --now "${SERVICE_NAME}-update.timer" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  systemctl restart "$TASK_SERVICE_NAME"
}

redact_agent_output() {
  sed \
    -e 's/[Bb]earer[[:space:]][^[:space:]]*/Bearer [REDACTED]/g' \
    -e 's/nst_[A-Za-z0-9._-]*/[REDACTED]/g'
}

systemd_agent_logs_since_install() {
  journalctl -u "$SERVICE_NAME" --since "@${INSTALL_STARTED_AT}" --no-pager -o cat 2>/dev/null || true
}

print_systemd_agent_diagnostics() {
  systemctl status "$SERVICE_NAME" --no-pager -l 2>&1 | redact_agent_output >&2 || true
  systemd_agent_logs_since_install | tail -n 80 | redact_agent_output >&2 || true
}

verify_rootless_agent_health() {
  local waited=0 logs=""
  while (( waited < HEALTH_CHECK_TIMEOUT_SEC )); do
    logs="$(journalctl --user -u "$SERVICE_NAME" --since "@${INSTALL_STARTED_AT}" --no-pager -o cat 2>/dev/null || true)"
    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null       && grep -q '"submitted_at"' <<<"$logs"; then
      ok "rootless 服务运行正常，首包已上报"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  err "Agent 未能在 ${HEALTH_CHECK_TIMEOUT_SEC}s 内完成首包上报，安装未通过健康检查"
  systemctl --user status "$SERVICE_NAME" --no-pager -l 2>&1 | redact_agent_output >&2 || true
  journalctl --user -u "$SERVICE_NAME" --since "@${INSTALL_STARTED_AT}" --no-pager -o cat 2>/dev/null | tail -n 80 | redact_agent_output >&2 || true
  return 1
}

verify_systemd_agent_health() {
  local waited=0 logs=""
  while (( waited < HEALTH_CHECK_TIMEOUT_SEC )); do
    logs="$(systemd_agent_logs_since_install)"
    if systemctl is-active --quiet "$SERVICE_NAME" \
      && systemctl is-active --quiet "$TASK_SERVICE_NAME" \
      && grep -q '"submitted_at"' <<<"$logs"; then
      ok "systemd 服务运行正常，首包已上报"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  err "Agent 未能在 ${HEALTH_CHECK_TIMEOUT_SEC}s 内完成首包上报，安装未通过健康检查"
  print_systemd_agent_diagnostics
  return 1
}

service_log_lines() {
  local file="$1"
  if [[ -f "$file" ]]; then wc -l < "$file" | tr -d '[:space:]'
  else printf '0'
  fi
}

verify_file_logged_agent_health() {
  local file="$1" start_line="$2" service_label="$3" waited=0 logs=""
  while (( waited < HEALTH_CHECK_TIMEOUT_SEC )); do
    if [[ -f "$file" ]]; then
      logs="$(tail -n "+$((start_line + 1))" "$file" 2>/dev/null || true)"
      if grep -q '"submitted_at"' <<<"$logs"; then
        ok "${service_label} 服务运行正常，首包已上报"
        return 0
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done

  err "Agent 未能在 ${HEALTH_CHECK_TIMEOUT_SEC}s 内完成首包上报，安装未通过健康检查"
  if [[ -f "$file" ]]; then tail -n 80 "$file" | redact_agent_output >&2 || true; fi
  return 1
}

install_openrc_update_job() {
  local job_dir=""
  if [[ -d /etc/periodic/hourly ]]; then
    job_dir="/etc/periodic/hourly"
  elif [[ -d /etc/cron.hourly ]]; then
    job_dir="/etc/cron.hourly"
  else
    warn "未找到 OpenRC 每小时任务目录；请使用 cftz update 手动更新"
    return 0
  fi
  cat > "${job_dir}/${SERVICE_NAME}-update" <<EOF
#!/bin/sh
if rc-service ${TASK_SERVICE_NAME} status >/dev/null 2>&1; then
  exit 0
fi
exec ${CFTZ_BIN} update --automatic >>/var/log/${SERVICE_NAME}-update.log 2>&1
EOF
  chmod 0755 "${job_dir}/${SERVICE_NAME}-update"
  if [[ -x /etc/init.d/crond ]]; then
    rc-update add crond default >/dev/null 2>&1 || true
    rc-service crond start >/dev/null 2>&1 || true
  elif [[ -x /etc/init.d/cron ]]; then
    rc-update add cron default >/dev/null 2>&1 || true
    rc-service cron start >/dev/null 2>&1 || true
  fi
}

install_openrc_service() {
  cat > "/etc/init.d/${SERVICE_NAME}" <<EOF
#!/sbin/openrc-run
name="${SERVICE_NAME}"
description="NIE-SLA VPS Metrics Agent"

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
  cat > "/etc/init.d/${TASK_SERVICE_NAME}" <<EOF
#!/sbin/openrc-run
name="${TASK_SERVICE_NAME}"
description="NIE-SLA privileged Agent manager"

start() {
    ebegin "Starting ${TASK_SERVICE_NAME}"
    start-stop-daemon --start --background --make-pidfile \
        --pidfile /run/${TASK_SERVICE_NAME}.pid \
        --exec /bin/sh -- \
        -c 'cd "${STATE_DIR}"; set -a; . "${ENV_FILE}"; set +a; export NIE_SLA_TASK_RUNNER_ONLY=1; exec "${WORK_DIR}/${BIN_NAME}" --task-runner-only >>"/var/log/${TASK_SERVICE_NAME}.log" 2>&1'
    eend \$?
}

stop() {
    ebegin "Stopping ${TASK_SERVICE_NAME}"
    start-stop-daemon --stop --pidfile /run/${TASK_SERVICE_NAME}.pid
    eend \$?
}

depend() { need net; after ${SERVICE_NAME}; }
EOF
  chmod +x "/etc/init.d/${TASK_SERVICE_NAME}"
  install_openrc_update_job
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-update add "$TASK_SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-service "$SERVICE_NAME" restart
  rc-service "$TASK_SERVICE_NAME" restart
}

do_uninstall() {
  case "${NIE_SLA_ROOTLESS:-${NSTATUS_ROOTLESS:-}}" in 1|true|TRUE|yes|YES)
    title "卸载 NIE-SLA Agent (rootless)"
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE_NAME}.service"
    systemctl --user daemon-reload 2>/dev/null || true
    pkill -f "${HOME}/nie-sla-agent/${BIN_NAME}" 2>/dev/null || true
    rm -rf "$HOME/nie-sla-agent" "${XDG_STATE_HOME:-$HOME/.local/state}/nie-sla-agent" "${HOME}/.local/bin/${BIN_NAME}" "${HOME}/.local/bin/cftz"
    ok "已卸载 (rootless)"
    return 0
    print_brand_banner "Agent 已卸载 · rootless"
  esac
  need_root
  title "卸载 NIE-SLA Agent"
  case "$(detect_init)" in
    systemd)
      systemctl stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable --now "$TASK_SERVICE_NAME" 2>/dev/null || true
      systemctl disable --now "${SERVICE_NAME}-update.timer" 2>/dev/null || true
      rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
      rm -f "/etc/systemd/system/${TASK_SERVICE_NAME}.service"
      rm -f "/etc/systemd/system/${SERVICE_NAME}-update.service" "/etc/systemd/system/${SERVICE_NAME}-update.timer"
      systemctl daemon-reload 2>/dev/null || true
      ;;
    openrc)
      rc-service "$SERVICE_NAME" stop 2>/dev/null || true
      rc-update del "$SERVICE_NAME" 2>/dev/null || true
      rc-service "$TASK_SERVICE_NAME" stop 2>/dev/null || true
      rc-update del "$TASK_SERVICE_NAME" 2>/dev/null || true
      rm -f "/etc/init.d/${SERVICE_NAME}" "/etc/init.d/${TASK_SERVICE_NAME}"
      rm -f "/etc/periodic/hourly/${SERVICE_NAME}-update" "/etc/cron.hourly/${SERVICE_NAME}-update"
      ;;
  esac
  rm -f "${INSTALL_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${LEGACY_SERVICE_NAME}" "$CFTZ_BIN"
  rm -rf "$WORK_DIR" "$STATE_DIR" "$MANAGER_STATE_DIR"
  userdel "$AGENT_USER" 2>/dev/null || deluser "$AGENT_USER" 2>/dev/null || true
  userdel "$LEGACY_TASK_USER" 2>/dev/null || deluser "$LEGACY_TASK_USER" 2>/dev/null || true
  ok "已卸载"
  print_brand_banner "Agent 已卸载"
}

NON_INTERACTIVE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    uninstall) do_uninstall; exit 0 ;;
    --api) NIE_SLA_API_BASE="$2"; shift 2 ;;
    --token) NIE_SLA_AGENT_TOKEN="$2"; shift 2 ;;
    --target) NIE_SLA_AGENT_ID="$2"; shift 2 ;;
    --label) NIE_SLA_AGENT_LABEL="$2"; shift 2 ;;
    --interval) NIE_SLA_INTERVAL_SEC="$2"; shift 2 ;;
    --ping-targets) NIE_SLA_PING_TARGETS="$2"; shift 2 ;;
    --ping-sec) NIE_SLA_PING_SEC="$2"; shift 2 ;;
    --non-interactive|-y) NON_INTERACTIVE=true; shift ;;
    *) shift ;;
  esac
done

if [[ "$ROOTLESS_MODE" != "true" ]]; then
  need_root
fi

API_BASE="${NIE_SLA_API_BASE:-${NSTATUS_API_BASE:-}}"
TOKEN="${NIE_SLA_AGENT_TOKEN:-${NSTATUS_AGENT_TOKEN:-}}"
AGENT_ID="${NIE_SLA_AGENT_ID:-${NSTATUS_AGENT_ID:-}}"
AGENT_LABEL="${NIE_SLA_AGENT_LABEL:-${NSTATUS_AGENT_LABEL:-}}"
INTERVAL="${NIE_SLA_INTERVAL_SEC:-${NSTATUS_INTERVAL_SEC:-300}}"
PING_TARGETS="${NIE_SLA_PING_TARGETS:-${NSTATUS_PING_TARGETS:-*}}"
PING_SEC="${NIE_SLA_PING_SEC:-${NSTATUS_PING_SEC:-20}}"

if [[ "$NON_INTERACTIVE" != "true" ]]; then
  title "NIE-SLA Agent 配置"
  if [[ -z "$API_BASE" ]]; then read -r -p "API base URL: " API_BASE </dev/tty; fi
  if [[ -z "$TOKEN" ]]; then read -r -s -p "Agent Token：" TOKEN </dev/tty; echo; fi
  if [[ -z "$AGENT_ID" ]]; then read -r -p "Target ID [$(hostname)]: " AGENT_ID </dev/tty; AGENT_ID="${AGENT_ID:-$(hostname)}"; fi
fi

if [[ -z "$API_BASE" ]]; then err "missing NIE_SLA_API_BASE or --api"; exit 2; fi
if [[ -z "$TOKEN" ]]; then err "missing NIE_SLA_AGENT_TOKEN or --token"; exit 2; fi
if [[ -z "$AGENT_ID" ]]; then AGENT_ID="$(hostname 2>/dev/null || echo vps)"; fi
if [[ -z "$AGENT_LABEL" ]]; then AGENT_LABEL="$AGENT_ID"; fi

API_BASE="${API_BASE%/}"
ARCH="$(detect_arch)"
INIT="$(detect_init)"
BIN_URL="${DOWNLOAD_BASE%/}/bin/${BIN_NAME}-linux-${ARCH}?v=${CACHE_KEY}"
TMPBIN="$(mktemp)"
TMPSUMS="$(mktemp)"
trap 'rm -f "$TMPBIN" "$TMPSUMS" "${CFTZ_TMP:-}"' EXIT INT TERM

title "安装 NIE-SLA Agent"
info "api: $API_BASE"
info "target: $AGENT_ID"
info "arch: $ARCH"

download_to "$BIN_URL" "$TMPBIN"
verify_binary_checksum "$TMPBIN" "${BIN_NAME}-linux-${ARCH}" "$TMPSUMS"
chmod +x "$TMPBIN"
verify_agent_version "$TMPBIN"
if [[ "$ROOTLESS_MODE" == "true" ]]; then
  mkdir -p "$WORK_DIR" "$INSTALL_DIR" "$STATE_DIR"
else
  stop_existing_agent
  create_users
  assert_safe_install_paths
  migrate_legacy_state
  mkdir -p "$WORK_DIR" "$INSTALL_DIR"
fi
install -m 0755 "$TMPBIN" "${WORK_DIR}/${BIN_NAME}" 2>/dev/null || { cp "$TMPBIN" "${WORK_DIR}/${BIN_NAME}"; chmod 0755 "${WORK_DIR}/${BIN_NAME}"; }
ln -sf "${WORK_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"
if [[ "$ROOTLESS_MODE" != "true" ]]; then
  ln -sf "${WORK_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${LEGACY_SERVICE_NAME}"
fi

CFTZ_URL="${CFTZ_URL_BASE%/}/cftz?v=${CACHE_KEY}"
CFTZ_TMP="$(mktemp)"
download_to "$CFTZ_URL" "$CFTZ_TMP" >/dev/null 2>&1 || { err "cftz 下载失败"; exit 1; }
CFTZ_EXPECTED_SHA256="${NIE_SLA_CFTZ_SHA256:-${NSTATUS_CFTZ_SHA256:-$DEFAULT_CFTZ_SHA256}}"
if [[ ! "$CFTZ_EXPECTED_SHA256" =~ ^[0-9A-Fa-f]{64}$ ]]; then
  err "cftz 缺少有效的 SHA-256"
  exit 1
fi
CFTZ_ACTUAL_SHA256="$(sha256_file "$CFTZ_TMP")"
if [[ "${CFTZ_ACTUAL_SHA256,,}" != "${CFTZ_EXPECTED_SHA256,,}" ]]; then
  err "cftz 的 SHA-256 不匹配"
  exit 1
fi
install -m 0755 "$CFTZ_TMP" "$CFTZ_BIN" 2>/dev/null || { cp "$CFTZ_TMP" "$CFTZ_BIN"; chmod 0755 "$CFTZ_BIN"; }
rm -f "$CFTZ_TMP"

write_env_file "$API_BASE" "$TOKEN" "$AGENT_ID" "$AGENT_LABEL" "$INTERVAL" "$PING_TARGETS" "$PING_SEC"
if [[ "$ROOTLESS_MODE" == "true" ]]; then
  chmod 0600 "$ENV_FILE"
  chmod 0755 "$WORK_DIR" "${WORK_DIR}/${BIN_NAME}"
else
  secure_install_permissions
fi

case "$INIT" in
  systemd)
    if [[ "$ROOTLESS_MODE" == "true" ]]; then
      install_rootless_service
      verify_rootless_agent_health
      info "logs: journalctl --user -u ${SERVICE_NAME} -f"
    else
      install_systemd_service
      verify_systemd_agent_health
      info "logs: journalctl -u ${SERVICE_NAME} -f"
    fi
    ;;
  openrc)
    LOG_START_LINE="$(service_log_lines "/var/log/${SERVICE_NAME}.log")"
    install_openrc_service
    verify_file_logged_agent_health "/var/log/${SERVICE_NAME}.log" "$LOG_START_LINE" "OpenRC"
    info "logs: tail -f /var/log/${SERVICE_NAME}.log"
    ;;
  *)
    warn "systemd/OpenRC not detected; starting in background"
    set -a; . "$ENV_FILE"; set +a
    : > "/var/log/${SERVICE_NAME}.log"
    "${WORK_DIR}/${BIN_NAME}" >"/var/log/${SERVICE_NAME}.log" 2>&1 &
    NIE_SLA_TASK_RUNNER_ONLY=1 "${WORK_DIR}/${BIN_NAME}" --task-runner-only >"/var/log/${TASK_SERVICE_NAME}.log" 2>&1 &
    verify_file_logged_agent_health "/var/log/${SERVICE_NAME}.log" 0 "后台"
    ;;
esac

verify_agent_version "${WORK_DIR}/${BIN_NAME}"

ok "安装完成"
if [[ "$ROOTLESS_MODE" == "true" ]]; then
  info "卸载: NIE_SLA_ROOTLESS=1 bash $0 uninstall"
else
  info "uninstall: curl -fsSL ${DOWNLOAD_BASE%/}/install.sh | sudo bash -s -- uninstall"
fi

BANNER_SUFFIX="Agent ${NIE_SLA_EXPECTED_VERSION:-${NSTATUS_EXPECTED_VERSION:-$DEFAULT_EXPECTED_VERSION}} · ${DOWNLOAD_BASE}"
if [[ "$ROOTLESS_MODE" == "true" ]]; then
  BANNER_SUFFIX="${BANNER_SUFFIX} · rootless"
fi
print_brand_banner "$BANNER_SUFFIX"
