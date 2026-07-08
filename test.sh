#!/usr/bin/env bash
# Basic smoke test: validates JS syntax, Rust Agent, shell scripts, and admin modules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || printf "%s" "$ROOT")"
export ROOT_WIN
PASS=0
FAIL=0
CARGO_BIN="${CARGO_BIN:-cargo}"
TMP_DIR="${TMPDIR:-/tmp}"

run_check() {
  local name="$1"; shift
  if "$@" >"$TMP_DIR/nstatus-test.out" 2>&1; then
    echo "  PASS $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL $name"
    sed 's/^/    /' "$TMP_DIR/nstatus-test.out"
    FAIL=$((FAIL+1))
  fi
}

run_shell() {
  local name="$1" cmd="$2"
  if bash -lc "$cmd" >"$TMP_DIR/nstatus-test.out" 2>&1; then
    echo "  PASS $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL $name"
    sed 's/^/    /' "$TMP_DIR/nstatus-test.out"
    FAIL=$((FAIL+1))
  fi
}

rm -f "$TMP_DIR/nstatus-test.out"

echo "=== Worker JS Syntax ==="
for f in "$ROOT/worker/src"/*.js; do
  run_check "$(basename "$f")" node --check "$f"
done
run_check "worker utility tests" node "$ROOT/worker/tests/utils.test.mjs"
run_shell "js undefined references" "cd '$ROOT' && npx --yes eslint@10.6.0 -c tests/eslint.config.mjs worker/src worker/tests frontend/app.js frontend/config.js frontend/functions frontend/js tests --no-error-on-unmatched-pattern"

echo ""
echo "=== Frontend JS Syntax ==="
run_check "app.js" node --check "$ROOT/frontend/app.js"
run_check "config.js" node --check "$ROOT/frontend/config.js"
run_shell "frontend modules" "python - <<'PY'
from pathlib import Path
import os, subprocess
root = Path(os.environ['ROOT_WIN'])
for rel in [
    'frontend/js/install-command.js',
    'frontend/js/shared/billing.js',
    'frontend/js/shared/format.js',
    'frontend/js/shared/html.js',
    'frontend/js/shared/traffic.js',
    'frontend/js/themes/nodeget-detail.js',
    'frontend/functions/api/[[path]].js',
    'frontend/functions/admin/[[path]].js',
]:
    subprocess.check_call(['node', '--check', str(root / rel)])
PY"
run_check "frontend shared imports" node --input-type=module -e "await import('./frontend/js/shared/html.js'); await import('./frontend/js/shared/format.js'); await import('./frontend/js/shared/billing.js'); await import('./frontend/js/shared/traffic.js')"
run_check "frontend app import smoke" node "$ROOT/tests/frontend-app-import-smoke.mjs"

echo ""
echo "=== Rust Agent ==="
run_shell "cargo fmt" "cd '$ROOT/agent' && $CARGO_BIN fmt -- --check"
run_shell "cargo check" "cd '$ROOT/agent' && $CARGO_BIN check"
run_shell "linux amd64 build" "cd '$ROOT/agent' && $CARGO_BIN build --release --target x86_64-unknown-linux-musl"

echo ""
echo "=== Shell Script Syntax ==="
for f in "$ROOT/agent/install.sh" "$ROOT/agent/setup.sh" "$ROOT/agent/cftz" "$ROOT/agent/update.sh" "$ROOT/agent/quick-install.sh"; do
  run_check "agent/$(basename "$f")" bash -n "$f"
done
run_check "cftz" bash -n "$ROOT/cftz"
run_check "frontend/cftz" bash -n "$ROOT/frontend/cftz"
run_check "worker/deploy.sh" bash -n "$ROOT/worker/deploy.sh"

echo ""
echo "=== Repository Hygiene ==="
run_shell "no real target seed data" "cd '$ROOT' && ! grep -E \"INSERT INTO targets|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+|niekaixiang|as6\\.org\" worker/targets-web-d1.sql"
run_shell "safe generated install command" "cd '$ROOT' && ! grep -E \"ExecutionPolicy Bypass|sudo env\" worker/src/admin.js"
run_shell "generated install command carries ping env" "cd '$ROOT' && grep -q \"NSTATUS_PING_TARGETS\" worker/src/admin.js && grep -q \"NSTATUS_PING_SEC\" worker/src/admin.js"
run_shell "cftz hides auth header args" "cd '$ROOT' && ! grep -R \"Authorization: Bearer \\\${tok}\" cftz agent/cftz frontend/cftz"
run_shell "no stale pages install host" "cd '$ROOT' && ! git grep -n \"nstatus-5fi.pages.dev\" -- agent frontend cftz docs README.md"
run_shell "single audit status source" "cd '$ROOT' && test -f docs/audit-status.md && test ! -e BUG_REPORT.md && test ! -e FINAL_STATUS.md && test ! -e DEEP_SECURITY_AUDIT.md && test ! -e ONE_CLICK_DEPLOY.md"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] || exit 1
