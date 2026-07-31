#!/bin/sh
set -eu

BASE_URL="${NSTATUS_AGENT_BASE_URL:-https://status.example.com}"
BASE_URL="${BASE_URL%/}"
DEFAULT_SETUP_SHA256="01bbe5c01bf6f17aa1e0973ffdc8d6ba3dcd4de8c12b35721db5c14a1939d781"

need_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" != "0" ]; then
    echo "Please run as root, for example: curl -fsSL ${BASE_URL}/install.sh | sudo sh" >&2
    exit 1
  fi
}

pkg_manager() {
  if command -v apk >/dev/null 2>&1; then echo apk
  elif command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  else echo ""; fi
}

install_pkg() {
  pm="$(pkg_manager)"
  [ -n "$pm" ] || { echo "Missing package manager; install bash and curl or wget manually." >&2; exit 1; }
  case "$pm" in
    apk) apk add --no-cache "$@" ;;
    apt) apt-get update -qq && apt-get install -y -qq "$@" ;;
    dnf|yum) "$pm" install -y -q "$@" ;;
  esac
}

download_to() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL "$url" -o "$out"; then return 0; fi
  fi
  if command -v wget >/dev/null 2>&1; then
    if wget -q "$url" -O "$out"; then return 0; fi
  fi
  install_pkg curl || install_pkg wget
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  else
    wget -q "$url" -O "$out"
  fi
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$file" | awk '{print $NF}'
  else echo "Missing sha256sum, shasum, or openssl for installer verification." >&2; exit 1; fi
}

need_root

if ! command -v bash >/dev/null 2>&1; then
  install_pkg bash
fi
tmp="$(mktemp "${TMPDIR:-/tmp}/nstatus-setup.XXXXXX")"
chmod 0600 "$tmp"
trap 'rm -f "$tmp"' EXIT INT TERM
cache_key="$(printf '%s' "${NSTATUS_SHA256SUMS_SHA256:-$(date +%s)}" | tr -cd 'A-Za-z0-9._-')"
[ -n "$cache_key" ] || cache_key="$(date +%s)"
download_to "${BASE_URL}/setup.sh?v=${cache_key}" "$tmp"
expected_setup_sha256="${NSTATUS_SETUP_SHA256:-$DEFAULT_SETUP_SHA256}"
case "$expected_setup_sha256" in
  *[!0-9A-Fa-f]*|'') echo "Invalid setup.sh SHA-256." >&2; exit 1 ;;
esac
[ "${#expected_setup_sha256}" -eq 64 ] || { echo "Invalid setup.sh SHA-256." >&2; exit 1; }
actual_setup_sha256="$(sha256_file "$tmp")"
expected_setup_sha256="$(printf '%s' "$expected_setup_sha256" | tr 'A-F' 'a-f')"
[ "$actual_setup_sha256" = "$expected_setup_sha256" ] || { echo "setup.sh SHA-256 verification failed." >&2; exit 1; }

export DOWNLOAD_BASE="${DOWNLOAD_BASE:-$BASE_URL}"
export CFTZ_URL_BASE="${CFTZ_URL_BASE:-$BASE_URL}"
export NSTATUS_PING_TARGETS="${NSTATUS_PING_TARGETS:-*}"
export NSTATUS_PING_SEC="${NSTATUS_PING_SEC:-20}"
bash "$tmp" "$@"
