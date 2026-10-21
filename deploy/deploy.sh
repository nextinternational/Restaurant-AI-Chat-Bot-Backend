#!/usr/bin/env bash
# Run on the VPS from the repo root:  ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env.production ] || { echo "Missing deploy/.env.production"; exit 1; }
[ -f .env ] || { echo "Missing deploy/.env (API_DOMAIN)"; exit 1; }
C="docker compose -f docker-compose.prod.yml"
$C build api
echo "== migrating database =="
$C run --rm api node dist/scripts/migrate.js
echo "== starting =="
$C up -d
sleep 8
set -a; . ./.env; set +a
curl -fsS "https://$API_DOMAIN/health/ready" && echo && echo "OK: API is live"
