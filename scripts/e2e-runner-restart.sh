#!/usr/bin/env bash
# Runner-restart recovery: instance dies -> gateway marks account unhealthy,
# reconciliation restarts it, gateway serves again. Reports the status codes seen.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
BASE=http://127.0.0.1:8800
A="Authorization: Bearer $PM_ADMIN_TOKEN"
J="content-type: application/json"
DC="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
KEY=$(curl -fsS -H "$A" -H "$J" -X POST $BASE/admin/api/keys -d '{"name":"e2e-5"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])')

acct() { curl -fsS -H "$A" $BASE/admin/api/accounts | python3 -c 'import sys,json; a=json.load(sys.stdin)[0]; print(a["status"], a.get("pid"), (a.get("last_error") or "")[:80])'; }

echo "== before: $(acct)"
echo "== restart runner"
$DC restart runner >/dev/null 2>&1
T0=$(date +%s)
echo "== immediately after: $(acct)"
echo "== first gateway call after restart (expect 502 or 503 while instance is down, account flips to unhealthy)"
curl -s -o /dev/null -w '%{http_code}\n' -m 60 -H "Authorization: Bearer $KEY" -H "$J" -X POST $BASE/v1/responses -d '{"input":"Reply with exactly: back"}'
echo "== after first call: $(acct)"
echo "== poll until the gateway answers 200 again"
for i in $(seq 1 40); do
  code=$(curl -s -o /tmp/last.json -w '%{http_code}' -m 60 -H "Authorization: Bearer $KEY" -H "$J" -X POST $BASE/v1/responses -d '{"input":"Reply with exactly: back"}')
  echo "  t+$(( $(date +%s) - T0 ))s http=$code account=$(acct)"
  [[ "$code" == "200" ]] && break
  sleep 3
done
python3 -c 'import json; d=json.load(open("/tmp/last.json")); print("reply:", d["output"][0]["content"][0]["text"] if d.get("output") else d)'
echo "== manager log lines about this"
$DC logs --no-color --since 3m manager-a manager-b 2>&1 | grep -E "unhealthy|not running|healthy|upstream request failed" | tail -8
