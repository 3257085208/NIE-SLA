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
if command -v npx >/dev/null 2>&1 && npx --version >/dev/null 2>&1; then
  PACKAGE_EXEC="npx --yes"
elif command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
  PACKAGE_EXEC="pnpm dlx"
else
  echo "npx or pnpm is required" >&2
  exit 1
fi
export PACKAGE_EXEC
TMP_PARENT="${TMPDIR:-/tmp}"
TMP_DIR="$(mktemp -d "$TMP_PARENT/nstatus-test.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT
# Keep linker intermediates out of Unicode/OneDrive paths without sharing stale
# artifacts between repositories or test runs.
if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
  CARGO_TARGET_DIR="$TMP_DIR/cargo-target"
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

echo "=== Worker JS Syntax ==="
for f in "$ROOT/worker/src"/*.js; do
  run_check "$(basename "$f")" node --check "$f"
done
run_check "worker utility tests" node "$ROOT/worker/tests/utils.test.mjs"
run_check "worker hardening tests" node "$ROOT/worker/tests/hardening.test.mjs"
run_check "third-party theme package tests" node "$ROOT/worker/tests/themes.test.mjs"
run_check "admin authentication tests" node "$ROOT/worker/tests/admin-auth.test.mjs"
run_check "custom admin path tests" node "$ROOT/worker/tests/admin-path.test.mjs"
run_check "admin reset tests" node "$ROOT/worker/tests/reset-admin.test.mjs"
run_check "application update tests" node "$ROOT/worker/tests/app-update.test.mjs"
run_check "independent traffic reset day tests" node "$ROOT/worker/tests/traffic-reset.test.mjs"
run_check "per-node Agent credential tests" node "$ROOT/worker/tests/agent-credentials.test.mjs"
run_check "Agent task, GeoIP, and backup tests" node "$ROOT/worker/tests/agent-tasks-backup.test.mjs"
run_check "NQ image host tests" node "$ROOT/worker/tests/nq-image-host.test.mjs"
run_check "durable telemetry buffer tests" node "$ROOT/worker/tests/telemetry-buffer.test.mjs"
run_check "Cloudflare free-tier budget tests" node "$ROOT/worker/tests/free-tier-budget.test.mjs"
run_check "bulk VPS target update tests" node "$ROOT/worker/tests/target-bulk.test.mjs"
run_check "email alert tests" node "$ROOT/worker/tests/alerts.test.mjs"
run_check "admin reset tool" node --check "$ROOT/worker/scripts/reset-admin.mjs"
run_check "external Latency agent tests" node "$ROOT/worker/tests/latency-agents.test.mjs"
run_check "Ping target color tests" node "$ROOT/worker/tests/ping-target-colors.test.mjs"
run_check "legacy chart color schema migration" node "$ROOT/worker/tests/schema-color-migration.test.mjs"
if [[ -f "$ROOT/scripts/export-public.mjs" ]]; then
  run_check "public export tool" node --check "$ROOT/scripts/export-public.mjs"
fi
run_shell "worker module bundle" "cd '$ROOT' && $PACKAGE_EXEC esbuild worker/src/index.js --bundle --format=esm --platform=browser --external:cloudflare:sockets --outfile='$TMP_DIR/nstatus-worker-bundle.mjs' && rm -f '$TMP_DIR/nstatus-worker-bundle.mjs'"
run_shell "js undefined references" "cd '$ROOT' && $PACKAGE_EXEC eslint@10.6.0 -c tests/eslint.config.mjs worker/src worker/tests frontend/app.js frontend/config.js frontend/functions frontend/js tests --no-error-on-unmatched-pattern"

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
run_shell "automatic updates reject downgrades" "cd '$ROOT' && bash -c 'set --; source agent/cftz >/dev/null; version_is_newer v1.0.20 v1.0.19; ! version_is_newer v1.0.18 v1.0.19; ! version_is_newer v1.0.19 v1.0.19'"
run_shell "OpenRC installs hourly verified updates" "cd '$ROOT' && grep -q '/etc/periodic/hourly' agent/setup.sh && grep -q '/etc/cron.hourly' agent/setup.sh && grep -q 'update --automatic' agent/setup.sh && grep -q '/etc/periodic/hourly' agent/cftz && grep -q '/etc/cron.hourly' agent/cftz && grep -q 'update --automatic' agent/cftz"
run_shell "cftz hides auth header args" "cd '$ROOT' && ! grep -R \"Authorization: Bearer \\\${tok}\" cftz agent/cftz frontend/cftz"
run_shell "admin reset never accepts password args" "cd '$ROOT' && ! grep -E \"argumentValue\\(['\\\"]--password|--password[= ]\" worker/scripts/reset-admin.mjs"
run_shell "no stale pages install host" "cd '$ROOT' && ! git grep -n \"nstatus-5fi.pages.dev\" -- agent frontend cftz docs README.md"
run_shell "missed write backfill enabled" "cd '$ROOT' && grep -q 'MISSED_WRITE_BACKFILL_MAX_BUCKETS = \"6\"' worker/wrangler.toml && ! grep -q 'MISSED_WRITE_BACKFILL_MAX_BUCKETS = \"0\"' worker/wrangler.toml"
run_shell "probe cron uses bounded target concurrency" "cd '$ROOT' && grep -q 'CONCURRENCY = \"20\"' worker/wrangler.toml && grep -q \"scheduled:probe:last\" worker/src/index.js"
run_shell "probe cron has one-minute retry windows" "cd '$ROOT' && grep -q 'crons = \[\"\* \* \* \* \*\"\]' worker/wrangler.toml && grep -q 'no_targets_due' worker/src/index.js"
run_shell "deployment covers 100 targets in five minute slots" "cd '$ROOT' && grep -q 'CONCURRENCY = \"20\"' worker/wrangler.toml && grep -q 'MAX_TARGETS_PER_RUN = \"20\"' worker/wrangler.toml"
run_shell "fixed Beta tasks only" "cd '$ROOT' && grep -q 'https://run.NodeQuality.com' agent/src/tasks.rs && grep -q 'https://IP.Check.Place' agent/src/tasks.rs && grep -q 'v\\\\ny\\\\ny\\\\ny' agent/src/tasks.rs && grep -q 'IP_UNLOCK_ARGS.*\[\"-4\", \"-j\", \"-n\", \"-p\"\]' agent/src/tasks.rs && ! grep -R -E 'NSTATUS_UNLOCK_CHECK|install_unlock_deps' cftz agent/cftz frontend/cftz && ! grep -R -E 'body\?\.(command|script|args|stdin)|body\[(.command.|.script.|.args.|.stdin.)\]' worker/src/admin/agent-tasks.js"
run_shell "legacy task fallback stays IP-only and heartbeat-aware" "cd '$ROOT' && grep -q 'Some(\"ip_unlock\")' agent/src/tasks.rs && grep -q 'manager::is_active' agent/src/tasks.rs && grep -q 'manager-heartbeat' agent/src/manager.rs && grep -q 'actions=' agent/src/tasks.rs && grep -q 'allowedActionsValue' worker/src/admin/agent-tasks.js"
run_shell "compatibility IP unlock uses the unprivileged state directory" "cd '$ROOT' && grep -q 'task_runtime_directory(&cfg.queue_file' agent/src/tasks.rs && grep -q 'metadata.uid() != uid' agent/src/tasks.rs && grep -q '\\.env(\"HOME\", &task_dir)' agent/src/tasks.rs"
run_shell "current Agent update repairs missing task service" "cd '$ROOT' && grep -A4 '__ALREADY_CURRENT__' agent/cftz | grep -q 'reconcile_service_layout' && grep -q 'systemctl is-active --quiet \"\$TASK_SERVICE_NAME\"' agent/cftz"
run_shell "permanent Manager owns fixed actions and updates" "cd '$ROOT' && grep -q 'spawn_manager_update_worker' agent/src/manager.rs && grep -q 'poll_once_manager' agent/src/manager.rs && grep -q 'bootstrap_if_root' agent/src/main.rs && grep -q 'retire_legacy_update_job' agent/src/manager.rs && grep -q 'manager::is_active' agent/src/updater.rs"
run_shell "Manager state and update rollback stay root controlled" "cd '$ROOT' && grep -q '/var/lib/nstatus-manager/manager-heartbeat' agent/src/manager.rs && grep -q 'ensure_manager_state_dir' agent/src/manager.rs && grep -q 'spawn_update_watchdog' agent/src/manager.rs && grep -q 'systemd-run' agent/src/manager.rs && grep -q 'rollback_failed_update' agent/src/manager.rs"
run_shell "Manager capabilities are allow-listed end to end" "cd '$ROOT' && grep -q '\"capabilities\": manager::reported_capabilities' agent/src/main.rs && grep -q 'normalizeAgentCapabilities' worker/src/metrics.js && grep -q 'agent_runtime' worker/src/admin/targets.js && grep -q 'capabilities?.actions' worker/src/admin/agent-tasks.js"
run_shell "fixed tasks do not use remote shell strings" "cd '$ROOT' && ! grep -q 'bash <(curl' agent/src/tasks.rs && ! grep -q '\.arg(\"-lc\")' agent/src/tasks.rs && grep -q '\.env_clear()' agent/src/tasks.rs"
run_shell "IP unlock compatibility stays task-local" "cd '$ROOT' && grep -q 'OPTIONAL_DIG_HELPER' agent/src/tasks.rs && grep -q 'OPTIONAL_NSLOOKUP_HELPER' agent/src/tasks.rs && grep -q 'NSTATUS_DNS_COMPAT_EXECUTABLE' agent/src/tasks.rs && grep -q 'task_dir.join(\"bin\")' agent/src/tasks.rs && grep -q 'set_private_executable_permissions' agent/src/tasks.rs && ! grep -qE 'Command::new\(\"(apt|apt-get|dnf|yum|pacman|apk)\"\)|\b(apt|apt-get|dnf|yum|pacman|apk) (install|add)\b' agent/src/tasks.rs"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] || exit 1
