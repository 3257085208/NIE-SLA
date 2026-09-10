#!/bin/sh

# This script is embedded in the Agent binary and is intentionally not a
# general command runner. The caller can only select one of the three fixed
# carrier probe destinations below.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# The privileged Agent passes the target through the environment and also
# keeps a positional fallback. `sh -s <name> <arg>` puts <name> at $1, so the
# environment variable is the only safe channel for fixed-task arguments.
target_ip="${NIE_SLA_BACKROUTE_TARGET:-${1:-}}"
case "$target_ip" in
  219.141.136.12|202.106.50.1|221.130.33.52) ;;
  *)
    echo "unsupported backroute destination: ${target_ip:-<empty>}" >&2
    exit 64
    ;;
esac

echo "target=$target_ip"

run_probe() {
  label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  if command -v timeout >/dev/null 2>&1; then
    timeout 25s "$@"
    rc=$?
  else
    "$@"
    rc=$?
  fi
  printf 'probe_exit=%s\n' "$rc"
}

if command -v traceroute >/dev/null 2>&1; then
  help_text="$(traceroute --help 2>&1 || true)"
  as_flag=""
  if printf '%s\n' "$help_text" | grep -Eq -- '--as-path-lookups'; then
    as_flag="--as-path-lookups"
  elif [ "$(uname -s 2>/dev/null || true)" = "Linux" ] \
    && printf '%s\n' "$help_text" | grep -Eq '(^|[[:space:]])-A([[:space:],]|$)'; then
    as_flag="-A"
  fi

  if [ -n "$as_flag" ]; then
    run_probe "traceroute-tcp443" traceroute -n "$as_flag" -T -p 443 -q 1 -w 1 -m 20 "$target_ip"
  else
    run_probe "traceroute-tcp443" traceroute -n -T -p 443 -q 1 -w 1 -m 20 "$target_ip"
  fi

  if [ -n "$as_flag" ]; then
    run_probe "traceroute-icmp" traceroute -n "$as_flag" -I -q 1 -w 1 -m 20 "$target_ip"
  else
    run_probe "traceroute-icmp" traceroute -n -I -q 1 -w 1 -m 20 "$target_ip"
  fi

  if [ -n "$as_flag" ]; then
    run_probe "traceroute-udp" traceroute -n "$as_flag" -q 1 -w 1 -m 20 "$target_ip"
  else
    run_probe "traceroute-udp" traceroute -n -q 1 -w 1 -m 20 "$target_ip"
  fi
  if command -v tracepath >/dev/null 2>&1; then
    run_probe "tracepath" tracepath -n -m 20 "$target_ip"
  fi
elif command -v tracepath >/dev/null 2>&1; then
  run_probe "tracepath" tracepath -n -m 20 "$target_ip"
else
  echo "system lacks traceroute or tracepath" >&2
  exit 127
fi
