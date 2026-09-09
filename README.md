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
  Each account row shows a health strip (20 x 10 min success/failure
  buckets), the official 5h / 7d quota windows with reset countdown, and
  cost in both currencies (gateway estimate vs official billing).
* **Account usage panel** (per account): 概览 / 明细 / 质量 / 官方 / 请求
  tabs with per-day trend, model and key distribution, token composition,
  error / TTFT / P95 / stream / cache signals, a paged request log, and the
  official ChatGPT accounting: per-day credits (1 USD = 25 credits) split
  by client and by model x speed, cycle estimate (used ÷ used %), plus the
  rate-limit reset vouchers (list with expiry, consume with an idempotent
  redeem id). Gateway cost is estimated at write time from the embedded
  `src/pricing.json` (USD per 1M tokens, same format as codex2api;
  extend/override with `PM_PRICING_FILE`).
  Built on [ASXS-API/frontend-template](https://github.com/ASXS-API/frontend-template)
  (React 19 / Vite / Tailwind / shadcn) in `web/`, compiled into the binary.
  Single admin token; the login exchanges it for a session token, and the
  admin token itself also works as `Authorization: Bearer` for scripts.
* **A/B slots (Android-style)**: two manager replicas behind HAProxy, both
  always up, but only the *active* slot receives traffic and runs the
  background jobs (health checks, reconciliation, auth.json sync, official
  usage probes, pruning); the standby is a hot spare holding the previous
  version. A `deployment` control service performs releases as a resumable
  stage machine; the 部署 page and `deploy/abctl.py` drive it, and versions
  are detected straight from ghcr (`sha-<sha>` tags, commit subject from
  image labels).

## Quick start (docker compose)

```
git clone https://github.com/meglinge/codexs-poolmanager.git && cd codexs-poolmanager
cp .env.example .env            # set PM_ADMIN_TOKEN, PM_RUNNER_TOKEN, POSTGRES_PASSWORD, PM_DEPLOY_TOKEN
docker compose up -d postgres redis haproxy deployment
python3 deploy/abctl.py deploy latest   # first time: both slots get the newest sha-<sha> image, slot a active
python3 deploy/abctl.py runner latest
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

### Releases (A/B slots, no downtime)

Two slots `manager-a` / `manager-b` are always running. HAProxy sends every
request to the slot named in the runtime map `deploy/state/active.map`
(`main manager_a|manager_b`); the other slot is ready but idle and does not
compete for the background-job leader lock (Redis key `pm:deploy:active`).

```
python3 deploy/abctl.py status        # slots, images, who has traffic / the leader lock
python3 deploy/abctl.py releases      # sha-<sha> images on ghcr, build time, commit subject, where each runs
python3 deploy/abctl.py deploy latest # or a short sha, or a full image name
python3 deploy/abctl.py rollback      # seconds: flip back to the standby slot (previous version)
python3 deploy/abctl.py switch b      # pure traffic switch, versions untouched
python3 deploy/abctl.py resume        # continue an interrupted operation from its journal
python3 deploy/abctl.py runner latest # roll the runner (its instances restart once)
```

### Runner with a locally built codexs (no GitHub release round-trip)

The published image downloads `codexs` from a GitHub release, which is slow
when iterating on the codexs patch. On a host that has the Codex fork checked
out (`git clone -b codexs https://github.com/meglinge/codex ~/src/codex`) and
a Rust toolchain, `scripts/codexs-local-runner.sh` builds `codexs` from that
checkout, layers it over the current runner image
(`docker/Dockerfile.runner-local`) and rolls the runner:

```
scripts/codexs-local-runner.sh              # build the checked-out commit, roll runner
scripts/codexs-local-runner.sh origin/codexs   # fetch + checkout a ref first
CODEX_SRC=~/src/codex BASE_IMAGE=ghcr.io/meglinge/codexs-poolmanager:sha-8f59e84 scripts/codexs-local-runner.sh
```

The result is tagged `codexs-poolmanager-runner:<base sha>-codexs-<codex sha>`
(immutable, so `abctl` accepts it and can roll back to it); `abctl` does not
try to pull images that only exist locally. A release build takes ~14 min the
first time and a few minutes incrementally.

`deploy` = pull the image → recreate the standby slot → wait for
`/readyz` + HAProxy UP → mark the new slot active in Redis and wait until the
old slot released the leader lock → flip the HAProxy map (no reload) → wait
until the old slot's in-flight streams drain (never killed; on timeout the
operation parks at `cutover` and `resume` keeps waiting) → recreate the old
slot with **its previous image** (= rollback point). Every stage is journaled
in `deploy/state/operation.json`. Only immutable tags are accepted
(`latest` is refused). The 部署 page in the admin UI offers the same actions
(发布最新版本 / 安全切到 A|B / 回滚 / 继续未完成操作 / runner 滚到最新); the
managers proxy them to the `deployment` container with `PM_DEPLOY_TOKEN`, so
the token never reaches the browser.

`deploy/state` must live on persistent storage; never delete it to "reset".

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
| `--deploy-url` | `PM_DEPLOY_URL` | unset (部署 page disabled) |
| `--deploy-token` | `PM_DEPLOY_TOKEN` | unset |

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
* The leader also calls the zero-cost official usage endpoints
  (`chatgpt.com/backend-api/wham/…`) through each account's own proxy:
  live windows every ~minute, daily usage hourly (84-day backfill on the
  first sync). `PM_CODEX_UA_VERSION` sets the Codex CLI version in the
  User-Agent used for those calls.
* The runner keeps children only in memory: restarting the runner container
  restarts every instance (the reconciliation job brings them back).
* `/readyz` (Postgres + Redis reachable) is what HAProxy and the compose
  healthchecks use; `/healthz` is liveness and always 200 with details.
* Compose env for the deployment service: `PM_DEPLOY_TOKEN` (required),
  `DEPLOY_ROOT` (absolute compose dir on the host), `DEPLOY_TIMEOUT` /
  `DEPLOY_DRAIN_WAIT`, `PM_GITHUB_TOKEN` (optional commit subjects for old
  images), `PM_HAPROXY_ADMIN_PORT` / `PM_DEPLOY_PORT` (host 127.0.0.1 only).
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

CI runs fmt/clippy/tests, `deploy/test_abctl.py`, and an end-to-end smoke test
against real Postgres and Redis with a stub codexs, then publishes
`ghcr.io/meglinge/codexs-poolmanager` (`sha-<sha7>` for every main commit,
`latest` from `main`, semver from `v*` tags) with the commit subject/author in
the image labels `pm.commit.subject` / `pm.commit.author`.
