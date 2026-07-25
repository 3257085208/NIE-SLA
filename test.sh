#!/usr/bin/env bash
# Basic smoke test: validates JS syntax, Rust Agent, shell scripts, and admin modules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || printf "%s" "$ROOT")"
export ROOT_WIN
PASS=0
FAIL=0
CARGO_BIN="${CARGO_BIN:-cargo}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || command -v python || true)}"
TMP_DIR="${TMPDIR:-/tmp}"
# Keep linker intermediates out of Unicode/OneDrive paths without sharing stale
# artifacts between repositories or test runs.
if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
  CARGO_TARGET_DIR="$(mktemp -d "$TMP_DIR/nstatus-cargo-target.XXXXXX")"
  trap 'rm -rf -- "$CARGO_TARGET_DIR"' EXIT
fi
export CARGO_TARGET_DIR

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

if [[ -f "$ROOT/worker/package-lock.json" && ! -d "$ROOT/worker/node_modules/fflate" ]]; then
  npm ci --prefix "$ROOT/worker" --ignore-scripts --no-audit --no-fund
fi

echo "=== Worker JS Syntax ==="
for f in "$ROOT/worker/src"/*.js; do
  run_check "$(basename "$f")" node --check "$f"
done
run_check "worker utility tests" node "$ROOT/worker/tests/utils.test.mjs"
run_check "worker hardening tests" node "$ROOT/worker/tests/hardening.test.mjs"
run_check "admin authentication tests" node "$ROOT/worker/tests/admin-auth.test.mjs"
run_check "custom admin path tests" node "$ROOT/worker/tests/admin-path.test.mjs"
run_check "admin reset tests" node "$ROOT/worker/tests/reset-admin.test.mjs"
run_check "per-node Agent credential tests" node "$ROOT/worker/tests/agent-credentials.test.mjs"
run_check "email alert tests" node "$ROOT/worker/tests/alerts.test.mjs"
run_check "admin reset tool" node --check "$ROOT/worker/scripts/reset-admin.mjs"
run_check "external Latency agent tests" node "$ROOT/worker/tests/latency-agents.test.mjs"
run_check "extension package tests" node "$ROOT/worker/tests/extensions.test.mjs"
if [[ -f "$ROOT/scripts/export-public.mjs" ]]; then
  run_check "public export tool" node --check "$ROOT/scripts/export-public.mjs"
fi
run_shell "worker module bundle" "cd '$ROOT' && npx --yes esbuild worker/src/index.js --bundle --format=esm --platform=browser --external:cloudflare:sockets --outfile='$TMP_DIR/nstatus-worker-bundle.mjs' && rm -f '$TMP_DIR/nstatus-worker-bundle.mjs'"
run_shell "js undefined references" "cd '$ROOT' && npx --yes eslint@10.6.0 -c tests/eslint.config.mjs worker/src worker/tests frontend/app.js frontend/config.js frontend/functions frontend/js tests --no-error-on-unmatched-pattern"

echo ""
echo "=== Frontend JS Syntax ==="
run_check "app.js" node --check "$ROOT/frontend/app.js"
run_check "config.js" node --check "$ROOT/frontend/config.js"
run_shell "frontend modules" "'$PYTHON_BIN' - <<'PY'
from pathlib import Path
import os, subprocess
root = Path(os.environ['ROOT_WIN'])
html = (root / 'frontend' / 'admin.html').read_text(encoding='utf-8')
assert 'type=\"module\"' in html, 'admin.html should load module script'
for rel in [
    'frontend/js/admin.js',
    'frontend/js/admin/api.js',
    'frontend/js/install-command.js',
    'frontend/js/shared/billing.js',
    'frontend/js/shared/chart-data.js',
    'frontend/js/shared/format.js',
    'frontend/js/shared/html.js',
    'frontend/js/shared/traffic.js',
    'frontend/js/themes/card-detail.js',
    'frontend/functions/api/[[path]].js',
]:
    subprocess.check_call(['node', '--check', str(root / rel)])
PY"
run_check "frontend shared imports" node --input-type=module -e "await import('./frontend/js/shared/html.js'); await import('./frontend/js/shared/format.js'); await import('./frontend/js/shared/billing.js'); await import('./frontend/js/shared/chart-data.js'); await import('./frontend/js/shared/traffic.js')"
run_check "frontend app import smoke" node "$ROOT/tests/frontend-app-import-smoke.mjs"
run_check "frontend module tests" node "$ROOT/tests/frontend-modules.test.mjs"
run_check "installer manifest tests" node "$ROOT/tests/installer-manifest.test.mjs"

echo ""
echo "=== Rust Agent ==="
run_shell "cargo fmt" "cd '$ROOT/agent' && $CARGO_BIN fmt -- --check"
run_shell "cargo check" "cd '$ROOT/agent' && $CARGO_BIN check --locked"
run_shell "cargo test" "cd '$ROOT/agent' && $CARGO_BIN test --locked"
if command -v zig >/dev/null 2>&1 && "$CARGO_BIN" zigbuild --help >/dev/null 2>&1; then
  run_shell "linux amd64 build" "cd '$ROOT/agent' && $CARGO_BIN zigbuild --locked --release --target x86_64-unknown-linux-musl"
else
  run_shell "linux amd64 build" "cd '$ROOT/agent' && $CARGO_BIN build --locked --release --target x86_64-unknown-linux-musl"
fi

echo ""
echo "=== Shell Script Syntax ==="
for f in "$ROOT/agent/install.sh" "$ROOT/agent/setup.sh" "$ROOT/agent/cftz" "$ROOT/agent/update.sh" "$ROOT/agent/quick-install.sh" "$ROOT/agent/build-release.sh"; do
  run_check "agent/$(basename "$f")" bash -n "$f"
done
run_check "cftz" bash -n "$ROOT/cftz"
run_check "frontend/cftz" bash -n "$ROOT/frontend/cftz"
run_check "worker/deploy.sh" bash -n "$ROOT/worker/deploy.sh"

echo ""
echo "=== Repository Hygiene ==="
run_shell "no real target seed data" "cd '$ROOT' && ! grep -E \"INSERT INTO targets|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+|niekaixiang|as6\\.org\" worker/targets-web-d1.sql"
run_shell "safe generated install command" "cd '$ROOT' && ! grep -E \"ExecutionPolicy Bypass|sudo env\" worker/src/admin/install-command.js && ! grep -E \"ExecutionPolicy Bypass|sudo env\" worker/src/admin.js"
run_shell "generated install command carries ping env" "cd '$ROOT' && (grep -q \"NSTATUS_PING_SEC\" worker/src/admin/install-command.js || grep -q \"NSTATUS_PING_SEC\" worker/src/admin.js)"
run_shell "generated install command pins installer and version" "cd '$ROOT' && grep -q 'install.sh?v=' worker/src/admin/install-command.js && grep -q 'NSTATUS_EXPECTED_VERSION' worker/src/admin/install-command.js"
run_shell "linux reinstall replaces legacy agent" "cd '$ROOT' && grep -q 'stop_existing_agent' agent/setup.sh && grep -q 'verify_agent_version' agent/setup.sh && grep -q 'setup.sh?v=' agent/install.sh"
run_shell "linux agent keeps secrets root-owned" "cd '$ROOT' && grep -q 'chown \"root:\${agent_group}\" \"\$ENV_FILE\"' agent/setup.sh && grep -q 'EnvironmentFile=\${ENV_FILE}' agent/setup.sh && ! grep -q 'chown -R \"\$AGENT_USER\" \"\$WORK_DIR\"' agent/setup.sh"
run_shell "manual updates verify policy and checksums" "cd '$ROOT' && grep -q 'manifest_sha256' agent/cftz && grep -q 'Agent binary checksum mismatch' agent/cftz && ! grep -q 'download_binary_unverified' agent/cftz"
run_shell "cftz hides auth header args" "cd '$ROOT' && ! grep -R \"Authorization: Bearer \\\${tok}\" cftz agent/cftz frontend/cftz"
run_shell "admin reset never accepts password args" "cd '$ROOT' && ! grep -E \"argumentValue\\(['\\\"]--password|--password[= ]\" worker/scripts/reset-admin.mjs"
run_shell "no stale pages install host" "cd '$ROOT' && ! git grep -n \"nstatus-5fi.pages.dev\" -- agent frontend cftz docs README.md"
run_shell "single audit status source" "cd '$ROOT' && test -f docs/audit-status.md && test ! -e BUG_REPORT.md && test ! -e FINAL_STATUS.md && test ! -e DEEP_SECURITY_AUDIT.md && test ! -e ONE_CLICK_DEPLOY.md"
run_shell "missed write backfill enabled" "cd '$ROOT' && grep -q 'MISSED_WRITE_BACKFILL_MAX_BUCKETS = \"6\"' worker/wrangler.toml && ! grep -q 'MISSED_WRITE_BACKFILL_MAX_BUCKETS = \"0\"' worker/wrangler.toml"
run_shell "probe cron uses full target concurrency" "cd '$ROOT' && grep -q 'CONCURRENCY = \"40\"' worker/wrangler.toml && grep -q \"scheduled:probe:last\" worker/src/index.js"
run_shell "probe cron has one-minute retry windows" "cd '$ROOT' && grep -q 'crons = \[\"\* \* \* \* \*\"\]' worker/wrangler.toml && grep -q 'no_targets_due' worker/src/index.js"
run_shell "deploy script keeps full target concurrency" "cd '$ROOT' && grep -q 'CONCURRENCY = \"40\"' worker/deploy.sh && ! grep -q 'CONCURRENCY = \"8\"' worker/deploy.sh"
run_shell "no legacy IP unlock checks" "cd '$ROOT' && ! grep -R -E 'NSTATUS_UNLOCK_CHECK|IP\.Check\.Place|install_unlock_deps' cftz agent/cftz frontend/cftz"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] || exit 1
