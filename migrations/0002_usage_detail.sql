-- Per-request detail needed by the account usage panel, plus the official
-- (ChatGPT backend) quota snapshot and daily usage rows synced per account.

ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS model            TEXT,
    ADD COLUMN IF NOT EXISTS service_tier     TEXT,
    ADD COLUMN IF NOT EXISTS stream           BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS ttft_ms          INTEGER,
    ADD COLUMN IF NOT EXISTS reasoning_tokens BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_usd         DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS usage_events_account_model_idx ON usage_events (account_id, model);

-- Latest /backend-api/wham/usage answer per account (5h / 7d windows, plan,
-- credits, reset credits). One row per account, overwritten on every probe.
CREATE TABLE IF NOT EXISTS account_quota (
    account_id               UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok                       BOOLEAN NOT NULL DEFAULT TRUE,
    error                    TEXT,
    http_status              INTEGER,
    plan_type                TEXT,
    email                    TEXT,
    allowed                  BOOLEAN,
    limit_reached            BOOLEAN,
    primary_used_percent     DOUBLE PRECISION,
    primary_window_seconds   BIGINT,
    primary_reset_at         TIMESTAMPTZ,
    secondary_used_percent   DOUBLE PRECISION,
    secondary_window_seconds BIGINT,
    secondary_reset_at       TIMESTAMPTZ,
    additional_limits        JSONB NOT NULL DEFAULT '[]'::jsonb,
    credits                  JSONB,
    reset_credits_available  INTEGER NOT NULL DEFAULT 0,
    reset_credits_applicable INTEGER NOT NULL DEFAULT 0,
    reset_credits            JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw                      JSONB
);

-- Official per-day workspace usage (daily-workspace-usage-counts), merged with
-- the per-model share from daily-token-usage-breakdown for the same day.
CREATE TABLE IF NOT EXISTS account_daily_usage (
    account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day            DATE NOT NULL,
    users          INTEGER NOT NULL DEFAULT 0,
    threads        INTEGER NOT NULL DEFAULT 0,
    turns          INTEGER NOT NULL DEFAULT 0,
    credits        DOUBLE PRECISION NOT NULL DEFAULT 0,
    uncached_input BIGINT,
    cached_input   BIGINT,
    output_tokens  BIGINT,
    total_tokens   BIGINT,
    clients        JSONB NOT NULL DEFAULT '[]'::jsonb,
    models         JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_shares   JSONB NOT NULL DEFAULT '[]'::jsonb,
    surfaces       JSONB NOT NULL DEFAULT '{}'::jsonb,
    settled        BOOLEAN NOT NULL DEFAULT FALSE,
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, day)
);

-- Sync bookkeeping for the official daily usage (first sync backfills deep).
CREATE TABLE IF NOT EXISTS account_daily_sync (
    account_id   UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_sync_at TIMESTAMPTZ,
    last_error   TEXT,
    backfilled   BOOLEAN NOT NULL DEFAULT FALSE
);
