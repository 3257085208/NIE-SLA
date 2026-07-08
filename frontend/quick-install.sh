#!/usr/bin/env bash
# Compatibility wrapper for one-line NStatus Agent installs.
# Required env:
#   NSTATUS_API_BASE or NSTATUS_API
#   NSTATUS_AGENT_TOKEN or NSTATUS_TOKEN
# Optional env:
#   NSTATUS_AGENT_ID or NSTATUS_TARGET
#   NSTATUS_AGENT_LABEL, NSTATUS_INTERVAL_SEC, NSTATUS_PING_TARGETS, NSTATUS_PING_SEC
#   NSTATUS_UNLOCK_CHECK_ENABLED, NSTATUS_UNLOCK_CHECK_SEC, NSTATUS_UNLOCK_CHECK_URL
set -euo pipefail

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://your-domain.com}"
SETUP_URL="${DOWNLOAD_BASE%/}/setup.sh"

if [[ -z "${NSTATUS_API_BASE:-${NSTATUS_API:-}}" ]]; then
  echo "Missing NSTATUS_API_BASE. Use the Admin deploy button to copy a complete command." >&2
  exit 2
fi
if [[ -z "${NSTATUS_AGENT_TOKEN:-${NSTATUS_TOKEN:-}}" ]]; then
  echo "Missing NSTATUS_AGENT_TOKEN. Use the Admin deploy button to copy a complete command." >&2
  exit 2
fi

export NSTATUS_API_BASE="${NSTATUS_API_BASE:-$NSTATUS_API}"
export NSTATUS_AGENT_TOKEN="${NSTATUS_AGENT_TOKEN:-$NSTATUS_TOKEN}"
export NSTATUS_AGENT_ID="${NSTATUS_AGENT_ID:-${NSTATUS_TARGET:-$(hostname 2>/dev/null || echo vps)}}"
export NSTATUS_AGENT_LABEL="${NSTATUS_AGENT_LABEL:-$NSTATUS_AGENT_ID}"
export NSTATUS_PING_TARGETS="${NSTATUS_PING_TARGETS:-*}"
export NSTATUS_PING_SEC="${NSTATUS_PING_SEC:-20}"
export NSTATUS_UNLOCK_CHECK_ENABLED="${NSTATUS_UNLOCK_CHECK_ENABLED:-1}"
export NSTATUS_UNLOCK_CHECK_SEC="${NSTATUS_UNLOCK_CHECK_SEC:-300}"
export NSTATUS_UNLOCK_CHECK_URL="${NSTATUS_UNLOCK_CHECK_URL:-https://IP.Check.Place}"
export NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC="${NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC:-90}"

TMP="$(mktemp)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SETUP_URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$SETUP_URL" -O "$TMP"
else
  echo "Missing curl or wget" >&2
  exit 2
fi

exec bash "$TMP" --non-interactive "$@"
