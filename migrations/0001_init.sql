-- poolmanager schema

CREATE TABLE IF NOT EXISTS runners (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    base_url    TEXT NOT NULL,            -- manager -> runner control API, e.g. http://runner:7000
    token       TEXT NOT NULL,            -- shared secret for the runner API
    public_host TEXT NOT NULL,            -- host the manager uses to reach codexs instances, e.g. runner
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY,
    name            TEXT NOT NULL,
    runner_id       TEXT NOT NULL REFERENCES runners(id) ON DELETE RESTRICT,
    port            INTEGER NOT NULL,
    proxy_url       TEXT,
    auth_json       JSONB NOT NULL,       -- Codex auth.json content
    max_concurrency INTEGER NOT NULL DEFAULT 4,
    rpm_limit       INTEGER,              -- NULL = unlimited
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    status          TEXT NOT NULL DEFAULT 'stopped',  -- stopped | starting | running | unhealthy | error
    pid             INTEGER,
    last_health     TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (runner_id, port)
);

CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY,
    name            TEXT NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE, -- sha256(key) hex
    key_prefix      TEXT NOT NULL,        -- first 12 chars for display
    max_concurrency INTEGER,              -- NULL = unlimited
    rpm_limit       INTEGER,              -- NULL = unlimited
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_events (
    id             BIGSERIAL PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    api_key_id     UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    account_id     UUID REFERENCES accounts(id) ON DELETE SET NULL,
    path           TEXT NOT NULL,
    status         INTEGER NOT NULL,
    latency_ms     INTEGER NOT NULL,
    input_tokens   BIGINT NOT NULL DEFAULT 0,
    output_tokens  BIGINT NOT NULL DEFAULT 0,
    cached_tokens  BIGINT NOT NULL DEFAULT 0,
    error          TEXT
);
CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events (ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_key_ts_idx ON usage_events (api_key_id, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_account_ts_idx ON usage_events (account_id, ts DESC);
