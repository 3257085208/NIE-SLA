#!/bin/sh

set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

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

run_probe_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 25s "$@"
  elif command -v busybox >/dev/null 2>&1; then
    busybox timeout 25 "$@"
  else
    "$@" &
    probe_pid=$!
    elapsed=0
    while kill -0 "$probe_pid" >/dev/null 2>&1; do
      if [ "$elapsed" -ge 25 ]; then
        kill -TERM "$probe_pid" >/dev/null 2>&1 || true
        sleep 1
        kill -KILL "$probe_pid" >/dev/null 2>&1 || true
        wait "$probe_pid" >/dev/null 2>&1 || true
        return 124
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
    wait "$probe_pid"
  fi
}

run_probe() {
  label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  probe_output="$(run_probe_bounded "$@" 2>&1)"
  rc=$?
  printf '%s\n' "$probe_output"
  printf 'probe_exit=%s\n' "$rc"
  probe_log="$probe_log
$probe_output"
}

has_hop_evidence() {
  printf '%s\n' "$probe_log" | grep -Eq '^[[:space:]]*[0-9]+[[:space:]]+.*[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'
}

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
    if printf '%s\n' "$raw" | grep -Fi "from $target_ip" >/dev/null 2>&1; then
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
