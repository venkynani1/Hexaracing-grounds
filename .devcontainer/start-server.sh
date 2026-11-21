#!/usr/bin/env bash
# Starts ONE game server process (one world) in the background and makes port 2567 public if allowed.
set -u
cd "$(dirname "$0")/.."
for v in DATABASE_URL SESSION_SECRET HOST_ADMIN_KEY; do
  [ -n "${!v:-}" ] || { echo "[redline] missing Codespaces secret $v — add it, then rebuild/restart the codespace"; exit 0; }
done
pkill -f "apps/server/src/index.ts" 2>/dev/null || true
export NODE_ENV=production PORT=2567 TRUST_PROXY=true PUBLIC_WEB_ORIGIN="https://code-redline.vercel.app" MAP=chennai
nohup node_modules/.bin/tsx apps/server/src/index.ts > /tmp/redline-server.log 2>&1 &
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:2567/api/health >/dev/null 2>&1 && break; sleep 1; done
grep "\[server\]" /tmp/redline-server.log | head -3
# Public port so phones can connect (may need the Ports tab instead if the codespace token lacks permission).
[ -n "${CODESPACE_NAME:-}" ] && gh codespace ports visibility 2567:public -c "$CODESPACE_NAME" >/dev/null 2>&1 && echo "[redline] port 2567 is public"
echo "[redline] server URL: https://${CODESPACE_NAME:-<codespace>}-2567.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
