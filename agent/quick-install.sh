#!/usr/bin/env bash
# Compatibility wrapper for one-line NIE-SLA Agent installs.
# Required env:
#   NSTATUS_API_BASE or NSTATUS_API
#   NSTATUS_AGENT_TOKEN or NSTATUS_TOKEN
# Optional env:
#   NSTATUS_AGENT_ID or NSTATUS_TARGET
#   NSTATUS_AGENT_LABEL, NSTATUS_INTERVAL_SEC, NSTATUS_PING_TARGETS, NSTATUS_PING_SEC
set -euo pipefail

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://status.example.com}"
SETUP_URL="${DOWNLOAD_BASE%/}/setup.sh"
DEFAULT_SETUP_SHA256="1b9f78834b203d5b19e9efde39077537c73cb2b21a0f9f6c85ec4fac5c62b17c"

if [[ -z "${NSTATUS_API_BASE:-${NSTATUS_API:-}}" ]]; then
  echo "缺少 NSTATUS_API_BASE，请从管理后台的部署按钮复制完整命令。" >&2
  exit 2
fi
if [[ -z "${NSTATUS_AGENT_TOKEN:-${NSTATUS_TOKEN:-}}" ]]; then
  echo "缺少 NSTATUS_AGENT_TOKEN，请从管理后台的部署按钮复制完整命令。" >&2
  exit 2
fi

export NSTATUS_API_BASE="${NSTATUS_API_BASE:-$NSTATUS_API}"
export NSTATUS_AGENT_TOKEN="${NSTATUS_AGENT_TOKEN:-$NSTATUS_TOKEN}"
export NSTATUS_AGENT_ID="${NSTATUS_AGENT_ID:-${NSTATUS_TARGET:-$(hostname 2>/dev/null || echo vps)}}"
export NSTATUS_AGENT_LABEL="${NSTATUS_AGENT_LABEL:-$NSTATUS_AGENT_ID}"
export NSTATUS_PING_TARGETS="${NSTATUS_PING_TARGETS:-*}"
export NSTATUS_PING_SEC="${NSTATUS_PING_SEC:-20}"

TMP="$(mktemp)"
chmod 0600 "$TMP"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SETUP_URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$SETUP_URL" -O "$TMP"
else
  echo "缺少 curl 或 wget" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  SETUP_ACTUAL_SHA256="$(sha256sum "$TMP" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  SETUP_ACTUAL_SHA256="$(shasum -a 256 "$TMP" | awk '{print $1}')"
elif command -v openssl >/dev/null 2>&1; then
  SETUP_ACTUAL_SHA256="$(openssl dgst -sha256 "$TMP" | awk '{print $NF}')"
else
  echo "缺少 sha256sum、shasum 或 openssl，无法校验安装器" >&2
  exit 2
fi
SETUP_EXPECTED_SHA256="${NSTATUS_SETUP_SHA256:-$DEFAULT_SETUP_SHA256}"
if [[ ! "$SETUP_EXPECTED_SHA256" =~ ^[0-9A-Fa-f]{64}$ ]] || [[ "${SETUP_ACTUAL_SHA256,,}" != "${SETUP_EXPECTED_SHA256,,}" ]]; then
  echo "setup.sh SHA-256 校验失败" >&2
  exit 2
fi

bash "$TMP" --non-interactive "$@"
