#!/usr/bin/env bash
# Run from a checkout with a live `docker compose` stack and a .env; needs a Codex login (CODEX_AUTH_JSON, default ~/.codex/auth.json).
# End-to-end test of a running poolmanager stack using the host's ~/.codex/auth.json.
# usage: pm-e2e.sh [base_url]   (reads PM_ADMIN_TOKEN / PM_RUNNER_TOKEN from .env in cwd)
set -uo pipefail
BASE="${1:-http://127.0.0.1:8800}"
set -a; source .env; set +a
A="Authorization: Bearer ${PM_ADMIN_TOKEN}"
J="content-type: application/json"
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

step "healthz"
curl -fsS "$BASE/healthz"; echo

step "register runner"
curl -fsS -H "$A" -H "$J" -X POST "$BASE/admin/api/runners" \
  -d "{\"id\":\"runner\",\"name\":\"compose runner\",\"base_url\":\"http://runner:7000\",\"token\":\"${PM_RUNNER_TOKEN}\",\"public_host\":\"runner\"}"; echo
curl -fsS -H "$A" "$BASE/admin/api/runners" | python3 -c 'import sys,json; [print(r["id"], "online" if r["online"] else "OFFLINE", r.get("codexs_bin")) for r in json.load(sys.stdin)]'

step "create account from ~/.codex/auth.json"
ACCOUNTS=$(curl -fsS -H "$A" "$BASE/admin/api/accounts")
ACC_ID=$(python3 -c 'import sys,json; a=[x for x in json.load(sys.stdin) if x["name"]=="sgv-main"]; print(a[0]["id"] if a else "")' <<<"$ACCOUNTS")
if [[ -z "$ACC_ID" ]]; then
  BODY=$(python3 -c 'import json; auth=json.load(open("${CODEX_AUTH_JSON:-$HOME/.codex/auth.json}")); print(json.dumps({"name":"sgv-main","runner_id":"runner","port":8790,"proxy_url":None,"max_concurrency":4,"auth_json":auth}))')
  ACC_ID=$(curl -fsS -H "$A" -H "$J" -X POST "$BASE/admin/api/accounts" -d "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
fi
echo "account: $ACC_ID"

step "wait for running"
for i in $(seq 1 45); do
  ST=$(curl -fsS -H "$A" "$BASE/admin/api/accounts/$ACC_ID" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["status"], d.get("last_error") or "")')
  echo "  $ST"; [[ "$ST" == running* ]] && break; sleep 3
done
[[ "$ST" == running* ]] || { echo "instance did not become healthy"; curl -s -H "$A" "$BASE/admin/api/accounts/$ACC_ID/logs?tail=60"; exit 1; }

step "instance logs (tail)"
curl -fsS -H "$A" "$BASE/admin/api/accounts/$ACC_ID/logs?tail=15"; echo

step "create api key"
KEY=$(curl -fsS -H "$A" -H "$J" -X POST "$BASE/admin/api/keys" -d '{"name":"e2e"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])')
echo "key: ${KEY:0:12}..."

step "GET /v1/models"
curl -fsS -H "Authorization: Bearer $KEY" "$BASE/v1/models" | head -c 300; echo

step "POST /v1/responses (non-stream)"
OUT=$(curl -sS -H "Authorization: Bearer $KEY" -H "$J" -X POST "$BASE/v1/responses" -d '{"input":"Reply with exactly: pong","instructions":"You are a terse assistant."}')
echo "$OUT" | head -c 600; echo
RESP_ID=$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' <<<"$OUT" || true)
echo "response id: $RESP_ID"

step "POST /v1/responses (stream, continue with previous_response_id -> sticky)"
curl -sS -N -H "Authorization: Bearer $KEY" -H "$J" -X POST "$BASE/v1/responses" \
  -d "{\"input\":\"Now reply with exactly: ping\",\"previous_response_id\":\"$RESP_ID\",\"stream\":true}" | grep -E '^(event|data): ' | head -12

step "POST /v1/chat/completions (stream)"
curl -sS -N -H "Authorization: Bearer $KEY" -H "$J" -X POST "$BASE/v1/chat/completions" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Say hi in three words."}],"stream":true}' | head -c 800; echo

step "usage"
sleep 1
curl -fsS -H "$A" "$BASE/admin/api/usage/recent?limit=5" | python3 -c 'import sys,json; [print(u["ts"][:19], u["path"], u["status"], f"{u[\"latency_ms\"]}ms", u["input_tokens"], u["output_tokens"], u["cached_tokens"], u.get("error") or "") for u in json.load(sys.stdin)]'

step "overview"
curl -fsS -H "$A" "$BASE/admin/api/overview" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("replica", d["instance"], "running", d["accounts_running"], "/", d["accounts_total"]); [print(" ", a["name"], a["status"], "inflight", a["inflight"]) for a in d["accounts"]]'
echo; echo "E2E OK"
