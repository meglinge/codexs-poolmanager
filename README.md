# poolmanager

Gateway, process supervisor and admin UI for a pool of
[codexs](https://github.com/meglinge/codex/tree/codexs/codex-rs/codexs) instances:
one ChatGPT/Codex account per `codexs server` process, each with its own
outbound proxy. Downstream clients see a single OpenAI-compatible endpoint and
authenticate with API keys managed here; codexs instances never see client
credentials.

```
clients ──► HAProxy ──► manager-a / manager-b ──► codexs :8790  (account 1, proxy A)
             :8800        (stateless gateway,    ──► codexs :8791  (account 2, proxy B)
                           admin UI /admin)      ──► …
                                │
                       Postgres + Redis                runner (supervises the
                       (accounts, keys, usage,         codexs processes)
                        in-flight counters, limits,
                        session stickiness, leader lock)
```

* **Gateway** `/v1/responses`, `/v1/chat/completions`, `/v1/models`: API-key
  auth, per-key and per-account concurrency / requests-per-minute limits
  (429 when exhausted), least-loaded account selection, conversation
  stickiness (`previous_response_id`, `x-asxs-session`) via Redis, streaming
  pass-through, usage accounting (tokens parsed from the response).
* **Runner**: same binary in `runner` mode; starts `codexs server --port …
  --proxy … --codex-home …` per account, writes the account's `auth.json`,
  keeps logs, reports status. Manager replicas can be updated without touching
  the instances.
* **Admin UI** at `/admin`: accounts (create from `auth.json`, proxy, limits,
  start/stop/restart, logs), API keys (secret shown once), runners, usage.
  Built on [ASXS-API/frontend-template](https://github.com/ASXS-API/frontend-template)
  (React 19 / Vite / Tailwind / shadcn) in `web/`, compiled into the binary.
  Single admin token; the login exchanges it for a session token, and the
  admin token itself also works as `Authorization: Bearer` for scripts.
* **Blue/green**: two manager replicas behind HAProxy; update one at a time.
  Background jobs (health checks, reconciliation, auth.json sync, usage
  pruning) run on whichever replica holds the Redis leader lock.

## Quick start (docker compose)

```
git clone https://github.com/meglinge/codexs-poolmanager.git && cd codexs-poolmanager
cp .env.example .env            # set PM_ADMIN_TOKEN, PM_RUNNER_TOKEN, POSTGRES_PASSWORD
docker compose up -d
open http://localhost:8800/admin
```

1. **Runners**: add `runner` with control URL `http://runner:7000`, instance
   host `runner`, and the `PM_RUNNER_TOKEN` from `.env`.
2. **Accounts**: paste the account's `auth.json` (from `codex login`), pick a
   port (unique per runner), optionally a proxy URL (`http://`, `socks5://`,
   `socks5h://`), concurrency and RPM limits. Enabled accounts are started by
   the background job within one health interval and show `running` once
   `/v1/models` answers.
3. **API keys**: create one; the secret is displayed once.
4. Call the gateway:

```
curl http://localhost:8800/v1/responses \
  -H "Authorization: Bearer pm-…" -H "content-type: application/json" \
  -d '{"model":"gpt-5","input":"hello","stream":true}'
```

### Updating the managers (A/B, no downtime)

```
# .env: IMAGE_TAG=<new version>
docker compose pull manager-a manager-b
docker compose up -d --no-deps manager-a      # HAProxy drops it while restarting, B keeps serving
docker compose up -d --no-deps manager-b
```

Rollback: put the previous `IMAGE_TAG` back and repeat. The runner and its
codexs processes are untouched by manager updates; update the runner
separately when a new codexs version is needed (its instances restart and are
brought back by the reconciliation job).

## Configuration

`poolmanager serve` (each flag has a `PM_*` env var):

| flag | env | default |
| --- | --- | --- |
| `--listen` | `PM_LISTEN` | `0.0.0.0:8800` |
| `--database-url` | `PM_DATABASE_URL` | required |
| `--redis-url` | `PM_REDIS_URL` | `redis://127.0.0.1:6379` |
| `--admin-token` | `PM_ADMIN_TOKEN` | required |
| `--instance-id` | `PM_INSTANCE_ID` | `a` |
| `--upstream-timeout-secs` | `PM_UPSTREAM_TIMEOUT_SECS` | `900` |
| `--sticky-ttl-secs` | `PM_STICKY_TTL_SECS` | `21600` |
| `--health-interval-secs` | `PM_HEALTH_INTERVAL_SECS` | `15` |
| `--usage-retention-days` | `PM_USAGE_RETENTION_DAYS` | `30` |

`poolmanager runner`:

| flag | env | default |
| --- | --- | --- |
| `--listen` | `PM_RUNNER_LISTEN` | `0.0.0.0:7000` |
| `--token` | `PM_RUNNER_TOKEN` | required |
| `--data-dir` | `PM_RUNNER_DATA_DIR` | `/data/runner` |
| `--codexs-bin` | `PM_CODEXS_BIN` | `codexs` |
| `--instance-bind-host` | `PM_INSTANCE_BIND_HOST` | `0.0.0.0` |

`poolmanager gen-secret` prints a random secret.

## Behaviour notes

* Limits are enforced in Redis, so they hold across replicas. Account
  `max_concurrency` caps concurrent turns on that instance; a pinned
  continuation (same conversation) bypasses the cap so a turn can finish.
* Selection is least-loaded (`inflight / max_concurrency`) among enabled,
  healthy accounts; accounts over their RPM are skipped for that minute.
* Response ids (`resp_…`, `chatcmpl-…`) and `x-asxs-session` headers pin
  follow-up requests to the same account for `PM_STICKY_TTL_SECS`.
* Codex refreshes OAuth tokens on disk; the leader syncs the instance's
  `auth.json` back into Postgres periodically so a move to another runner
  keeps working credentials.
* The runner keeps children only in memory: restarting the runner container
  restarts every instance (the reconciliation job brings them back).
* Codex's sandbox uses `bwrap`; in Docker the runner needs user namespaces
  (`security_opt: seccomp=unconfined`, `cap_add: SYS_ADMIN` in the compose file).

## Development

```
(cd web && npm ci && npm run build)      # admin UI -> web/dist (embedded at cargo build time)
cargo test
PM_DATABASE_URL=postgres://… PM_ADMIN_TOKEN=x cargo run -- serve
PM_RUNNER_TOKEN=y PM_CODEXS_BIN=/path/to/codexs cargo run -- runner
(cd web && npm run dev)                  # UI dev server on :5278, proxies /admin/api to :8800
```

CI runs fmt/clippy/tests plus an end-to-end smoke test against real Postgres
and Redis with a stub codexs, then publishes
`ghcr.io/meglinge/codexs-poolmanager` (`latest` from `main`, semver from `v*` tags).
