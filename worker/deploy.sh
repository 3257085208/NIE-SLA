#!/usr/bin/env bash
# NIE-SLA one-command deployment
# Usage: bash deploy.sh
set -euo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()  { echo -e "  ${GREEN}[OK]${NC} $*"; }

echo -e "\n${BOLD}NIE-SLA Deployment${NC}\n"

# 1. Prerequisites
command -v node &>/dev/null || { echo "Need Node.js 18+"; exit 1; }
npx wrangler --version &>/dev/null || { echo "Need wrangler: npm i -g wrangler"; exit 1; }
put_secret() { local name="$1" value="$2"; printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1; }

ok "Node.js + Wrangler ready"

# 2. Login check
if ! npx wrangler whoami &>/dev/null 2>&1; then
  echo -e "\n${BOLD}Wrangler login required${NC}"
  npx wrangler login
fi
ok "Wrangler authenticated"

# 3. Configuration
echo ""
read -rp "  Site name [NIE-SLA]: " SITE_NAME
SITE_NAME="${SITE_NAME:-NIE-SLA}"
read -rp "  Admin username [admin]: " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"
read -rp "  Timezone offset minutes [480]: " TZ
TZ="${TZ:-480}"

# 4. D1 database
echo ""
DB_NAME="nstatus-db"
if npx wrangler d1 list 2>/dev/null | grep -q "\"name\":\"$DB_NAME\""; then
  DB_ID=$(npx wrangler d1 list --json 2>/dev/null | grep -B1 "\"name\":\"$DB_NAME\"" | grep -o '[a-f0-9]\{8\}-[a-f0-9]\{4\}-[a-f0-9]\{4\}-[a-f0-9]\{4\}-[a-f0-9]\{12\}' | head -1)
  ok "D1 database exists: $DB_ID"
else
  echo "  Creating D1 database..."
  DB_OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
  DB_ID=$(echo "$DB_OUT" | grep -o '[a-f0-9]\{8\}-[a-f0-9]\{4\}-[a-f0-9]\{4\}-[a-f0-9]\{4\}-[a-f0-9]\{12\}' | head -1)
  ok "D1 created: $DB_ID"
fi

# 5. R2 bucket
echo ""
BUCKET_NAME="nstatus-archive"
if npx wrangler r2 bucket list 2>/dev/null | grep -q "$BUCKET_NAME"; then
  ok "R2 bucket exists: $BUCKET_NAME"
else
  echo "  Creating R2 bucket..."
  npx wrangler r2 bucket create "$BUCKET_NAME" >/dev/null 2>&1
  ok "R2 bucket created: $BUCKET_NAME"
fi

# 6. Secrets
echo ""
read -rsp "  Admin password (leave empty to keep existing): " ADMIN_PASS
echo
if [[ -n "$ADMIN_PASS" ]]; then
  put_secret ADMIN_PASSWORD "$ADMIN_PASS"
  ok "ADMIN_PASSWORD set"
else
  ok "ADMIN_PASSWORD skipped"
fi

read -rsp "  Agent token (leave empty to keep existing): " AGENT_TOK
echo
if [[ -n "$AGENT_TOK" ]]; then
  put_secret AGENT_TOKEN "$AGENT_TOK"
  ok "AGENT_TOKEN set"
else
  ok "AGENT_TOKEN skipped"
fi

read -rsp "  TOTP encryption key (leave empty to keep existing): " TOTP_KEY
echo
if [[ -n "$TOTP_KEY" ]]; then
  put_secret TOTP_ENCRYPTION_KEY "$TOTP_KEY"
  ok "TOTP_ENCRYPTION_KEY set"
else
  ok "TOTP_ENCRYPTION_KEY skipped"
fi

# 7. Worker domain
echo ""
read -rp "  Worker URL (required, e.g. https://nstatus.example.workers.dev): " WORKER_DOMAIN
WORKER_DOMAIN="${WORKER_DOMAIN%/}"
if [[ -z "$WORKER_DOMAIN" ]]; then
  echo "Worker URL is required so frontend and colo echo point to this deployment." >&2
  exit 1
fi

# 8. Write wrangler.toml
cat > wrangler.toml <<TOML
name = "nstatus"
main = "src/index.js"
compatibility_date = "2026-06-17"
workers_dev = true

[triggers]
crons = ["* * * * *"]

[vars]
PUBLIC_SITE_NAME = "$SITE_NAME"
ADMIN_USERNAME = "$ADMIN_USER"
PUBLIC_WORKER_URL = "$WORKER_DOMAIN"
PUBLIC_AGENT_API_BASE = "$WORKER_DOMAIN"
TIMEZONE_OFFSET_MINUTES = "$TZ"
CONCURRENCY = "40"
MAX_TARGETS_PER_RUN = "60"
CHECKS_DEFAULT_LIMIT = "864"
CHECKS_WINDOW_HOURS = "72"
INCIDENTS_TO_D1 = "true"
PUBLIC_MASK_IPS = "true"
AGENT_METRICS_RETENTION_HOURS = "6"
AGENT_METRICS_POINTS_PER_REPORT = "6"
AGENT_METRICS_R2_RETENTION_HOURS = "72"
AGENT_METRICS_TO_D1 = "false"
AGENT_PINGS_TO_D1 = "false"
PING_HISTORY_RETENTION_HOURS = "6"
RATE_LIMIT_D1 = "true"
MISSED_WRITE_BACKFILL_MAX_BUCKETS = "6"
ALERT_MAX_MESSAGES_PER_RUN = "30"
FAST_STATUS_ENABLED = "true"
FAST_STATUS_INTERVAL_SEC = "60"
FAST_STATUS_MAX_TARGETS = "50"

[[d1_databases]]
binding = "DB"
database_name = "$DB_NAME"
database_id = "$DB_ID"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "$BUCKET_NAME"

[[durable_objects.bindings]]
name = "REGION_PROXY"
class_name = "ProbeRegion"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ProbeRegion"]
TOML
ok "wrangler.toml written"

# 9. Deploy Worker
echo -e "\n${BOLD}Deploying Worker...${NC}"
npx wrangler deploy
ok "Worker deployed"

# 10. Frontend config
cd ../../frontend 2>/dev/null || { echo "  Production frontend sibling not found; run from the private worker/ directory"; exit 1; }
echo "window.NSTATUS_API_BASE = '$WORKER_DOMAIN';" > config.js
ok "Frontend config written"

# 11. Deploy Frontend
echo -e "\n${BOLD}Deploying Frontend...${NC}"
read -rp "  Pages project name [nstatus]: " PAGES_NAME
PAGES_NAME="${PAGES_NAME:-nstatus}"
npx wrangler pages deploy ./ --project-name="$PAGES_NAME"
ok "Frontend deployed"

echo -e "\n${GREEN}${BOLD}Deployment complete!${NC}"
echo "  Status page: https://${PAGES_NAME}.pages.dev"
echo "  API:         $WORKER_DOMAIN"
echo ""
echo "  Next steps:"
echo "    Open /admin, sign in, add a target, then copy its generated Agent command."
