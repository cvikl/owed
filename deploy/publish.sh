#!/usr/bin/env bash
# Publish Owed to the shared box -> https://owed.vantapointlabs.com
#   SERVER=root@host bash deploy/publish.sh
# App in /opt/owed, container on the existing Caddy network, Caddy drop-in in /opt/caddy-sites, zero-downtime reload.
set -euo pipefail
HOST=${SERVER:?set SERVER=user@host}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/owed
for k in OPENAI_API_KEY PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET; do grep -q "^$k=.\+" "$ROOT/.env" || { echo "$k must be set in .env"; exit 1; }; done
echo "==> rsync"
ssh "$HOST" "mkdir -p $APP_DIR /opt/caddy-sites"
rsync -az --delete --exclude node_modules --exclude .git --exclude 'data/attempts.jsonl' --exclude 'data/model-calls.jsonl' "$ROOT/" "$HOST:$APP_DIR/"
echo "==> build and start; copy results into the volume (the pool and the attempt log on the host are kept unless FIRST=1)"
ssh "$HOST" "cd $APP_DIR/deploy && docker compose build owed && docker compose up -d owed"
if [ "${FIRST:-0}" = "1" ]; then ssh "$HOST" "docker cp $APP_DIR/data/. owed:/data/"; else ssh "$HOST" "for f in bench-results.json; do [ -f $APP_DIR/data/\$f ] && docker cp $APP_DIR/data/\$f owed:/data/\$f; done; true"; fi
ssh "$HOST" "cd $APP_DIR/deploy && docker compose restart owed"
echo "==> caddy drop-in + reload"
rsync -az "$ROOT/deploy/owed.caddy" "$HOST:/opt/caddy-sites/owed.caddy"
ssh "$HOST" "cd /opt/compass/deploy && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile"
sleep 2
ssh "$HOST" "docker exec owed node -e \"fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)\""
