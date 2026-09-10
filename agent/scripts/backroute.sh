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
  219.141.136.12|202.106.50.1|221.130.33.52|202.96.209.133|210.22.97.1|221.5.88.88|211.136.192.6) ;;
  *)
    echo "unsupported backroute destination: ${target_ip:-<empty>}" >&2
    exit 64
    ;;
esac

echo "target=$target_ip"

probe_log=""

run_probe() {
  label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  if command -v timeout >/dev/null 2>&1; then
    probe_output="$(timeout 25s "$@" 2>&1)"
    rc=$?
  else
    probe_output="$("$@" 2>&1)"
    rc=$?
  fi
  printf '%s\n' "$probe_output"
  printf 'probe_exit=%s\n' "$rc"
  probe_log="$probe_log
$probe_output"
}

# True when any previous probe already produced a numbered hop line carrying
# an IPv4 address (traceroute formats differ, so only this loose shape is
# trusted across implementations).
has_hop_evidence() {
  printf '%s\n' "$probe_log" | grep -Eq '^[[:space:]]*[0-9]+[[:space:]]+.*[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'
}

# Last-resort path probe built on `ping -t TTL`, which exists on almost every
# minimal Linux image where traceroute/tracepath were never installed. The
# numbered hop lines below are parsed by the Agent exactly like traceroute
# output, and the hop IP ranges are what the line classifier needs.
run_ping_traceroute() {
  command -v ping >/dev/null 2>&1 || return 0
  printf '\n=== ping-ttl ===\n'
  ping_out=""
  ping_wait="-W 1"
  if [ "$(uname -s 2>/dev/null || echo Linux)" = "Darwin" ]; then
    ping_wait="-W 1000"
  fi
  ttl=1
  while [ "$ttl" -le 20 ]; do
    raw="$(ping -n -c 1 $ping_wait -t "$ttl" "$target_ip" 2>&1 || true)"
    router="$(printf '%s\n' "$raw" | sed -n 's/.*[Ff]rom \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)"
    if [ -n "$router" ]; then
      hop_line="$(printf '%d %s' "$ttl" "$router")"
    else
      hop_line="$(printf '%d *' "$ttl")"
    fi
    printf '%s\n' "$hop_line"
    ping_out="$ping_out
$hop_line"
    if printf '%s\n' "$raw" | grep -F "from $target_ip" >/dev/null 2>&1; then
      break
    fi
    ttl=$((ttl + 1))
  done
  printf 'probe_exit=0\n'
  probe_log="$probe_log
$ping_out"
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
  if ! has_hop_evidence; then
    run_ping_traceroute
  fi
elif command -v tracepath >/dev/null 2>&1; then
  run_probe "tracepath" tracepath -n -m 20 "$target_ip"
  if ! has_hop_evidence; then
    run_ping_traceroute
  fi
else
  run_ping_traceroute
  if [ -z "$probe_log" ]; then
    echo "system lacks traceroute, tracepath and ping" >&2
    exit 127
  fi
fi

exit 0
