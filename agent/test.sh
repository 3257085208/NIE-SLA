#!/usr/bin/env bash
# Agent-only smoke test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
CARGO_BIN="${CARGO_BIN:-cargo}"
TMP_DIR="${TMPDIR:-/tmp}"

run_check() {
  local name="$1"; shift
  if "$@" >"$TMP_DIR/nstatus-agent-test.out" 2>&1; then
    echo "  PASS $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL $name"
    sed 's/^/    /' "$TMP_DIR/nstatus-agent-test.out"
    FAIL=$((FAIL+1))
  fi
}

run_shell() {
  local name="$1" cmd="$2"
  if bash -lc "$cmd" >"$TMP_DIR/nstatus-agent-test.out" 2>&1; then
    echo "  PASS $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL $name"
    sed 's/^/    /' "$TMP_DIR/nstatus-agent-test.out"
    FAIL=$((FAIL+1))
  fi
}

echo "=== Rust Agent ==="
run_shell "cargo fmt" "cd '$ROOT' && $CARGO_BIN fmt -- --check"
run_shell "cargo check" "cd '$ROOT' && $CARGO_BIN check"
run_shell "linux amd64 build" "cd '$ROOT' && $CARGO_BIN build --release --target x86_64-unknown-linux-musl"

echo ""
echo "=== Shell Script Syntax ==="
for f in "$ROOT/install.sh" "$ROOT/setup.sh" "$ROOT/cftz" "$ROOT/update.sh" "$ROOT/quick-install.sh"; do
  run_check "$(basename "$f")" bash -n "$f"
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] || exit 1
