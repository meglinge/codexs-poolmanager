//! Rows synced from the official ChatGPT backend: the live quota snapshot
//! (`/wham/usage`) and the settled daily usage (daily-workspace-usage-counts
//! merged with the per-model token breakdown).

use chrono::DateTime;
use chrono::NaiveDate;
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AccountQuota {
    pub account_id: Uuid,
    pub fetched_at: DateTime<Utc>,
    pub ok: bool,
    pub error: Option<String>,
    pub http_status: Option<i32>,
    pub plan_type: Option<String>,
    pub email: Option<String>,
    pub allowed: Option<bool>,
    pub limit_reached: Option<bool>,
    pub primary_used_percent: Option<f64>,
    pub primary_window_seconds: Option<i64>,
    pub primary_reset_at: Option<DateTime<Utc>>,
    pub secondary_used_percent: Option<f64>,
    pub secondary_window_seconds: Option<i64>,
    pub secondary_reset_at: Option<DateTime<Utc>>,
    pub additional_limits: Value,
    pub credits: Option<Value>,
    pub reset_credits_available: i32,
    pub reset_credits_applicable: i32,
    pub reset_credits: Value,
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct QuotaUpsert {
    pub ok: bool,
    pub error: Option<String>,
    pub http_status: Option<i32>,
    pub plan_type: Option<String>,
    pub email: Option<String>,
    pub allowed: Option<bool>,
    pub limit_reached: Option<bool>,
    pub primary_used_percent: Option<f64>,
    pub primary_window_seconds: Option<i64>,
    pub primary_reset_at: Option<DateTime<Utc>>,
    pub secondary_used_percent: Option<f64>,
    pub secondary_window_seconds: Option<i64>,
    pub secondary_reset_at: Option<DateTime<Utc>>,
    pub additional_limits: Value,
    pub credits: Option<Value>,
    pub reset_credits_available: i32,
    pub reset_credits_applicable: i32,
    pub reset_credits: Value,
    pub raw: Option<Value>,
}

impl QuotaUpsert {
    pub fn failed(http_status: Option<i32>, error: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
            http_status,
            additional_limits: json!([]),
            reset_credits: json!([]),
            ..Default::default()
        }
    }
}

/// A failed probe keeps the last good numbers and only records the error.
pub async fn upsert_quota(pool: &PgPool, account_id: Uuid, q: &QuotaUpsert) -> sqlx::Result<()> {
    if !q.ok {
        sqlx::query(
            "INSERT INTO account_quota (account_id, fetched_at, ok, error, http_status)
             VALUES ($1, now(), false, $2, $3)
             ON CONFLICT (account_id) DO UPDATE SET fetched_at = now(), ok = false,
               error = EXCLUDED.error, http_status = EXCLUDED.http_status",
        )
        .bind(account_id)
        .bind(&q.error)
        .bind(q.http_status)
        .execute(pool)
        .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO account_quota (account_id, fetched_at, ok, error, http_status, plan_type, email, allowed, limit_reached,
            primary_used_percent, primary_window_seconds, primary_reset_at,
            secondary_used_percent, secondary_window_seconds, secondary_reset_at,
            additional_limits, credits, reset_credits_available, reset_credits_applicable, reset_credits, raw)
         VALUES ($1, now(), true, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (account_id) DO UPDATE SET fetched_at = now(), ok = true, error = NULL,
            http_status = EXCLUDED.http_status, plan_type = EXCLUDED.plan_type, email = EXCLUDED.email,
            allowed = EXCLUDED.allowed, limit_reached = EXCLUDED.limit_reached,
            primary_used_percent = EXCLUDED.primary_used_percent, primary_window_seconds = EXCLUDED.primary_window_seconds,
            primary_reset_at = EXCLUDED.primary_reset_at, secondary_used_percent = EXCLUDED.secondary_used_percent,
            secondary_window_seconds = EXCLUDED.secondary_window_seconds, secondary_reset_at = EXCLUDED.secondary_reset_at,
            additional_limits = EXCLUDED.additional_limits, credits = EXCLUDED.credits,
            reset_credits_available = EXCLUDED.reset_credits_available,
            reset_credits_applicable = EXCLUDED.reset_credits_applicable,
            reset_credits = EXCLUDED.reset_credits, raw = EXCLUDED.raw",
    )
    .bind(account_id)
    .bind(q.http_status)
    .bind(&q.plan_type)
    .bind(&q.email)
    .bind(q.allowed)
    .bind(q.limit_reached)
    .bind(q.primary_used_percent)
    .bind(q.primary_window_seconds)
    .bind(q.primary_reset_at)
    .bind(q.secondary_used_percent)
    .bind(q.secondary_window_seconds)
    .bind(q.secondary_reset_at)
    .bind(&q.additional_limits)
    .bind(&q.credits)
    .bind(q.reset_credits_available)
    .bind(q.reset_credits_applicable)
    .bind(&q.reset_credits)
    .bind(&q.raw)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_quota(pool: &PgPool, account_id: Uuid) -> sqlx::Result<Option<AccountQuota>> {
    sqlx::query_as::<_, AccountQuota>("SELECT * FROM account_quota WHERE account_id = $1")
        .bind(account_id)
        .fetch_optional(pool)
        .await
}

pub async fn list_quotas(pool: &PgPool) -> sqlx::Result<Vec<AccountQuota>> {
    sqlx::query_as::<_, AccountQuota>("SELECT * FROM account_quota")
        .fetch_all(pool)
        .await
}

// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DailyUsage {
    pub account_id: Uuid,
    pub day: NaiveDate,
    pub users: i32,
    pub threads: i32,
    pub turns: i32,
    pub credits: f64,
    pub uncached_input: Option<i64>,
    pub cached_input: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub clients: Value,
    pub models: Value,
    pub model_shares: Value,
    pub surfaces: Value,
    pub settled: bool,
    pub synced_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct DailyUsageUpsert {
    pub day: NaiveDate,
    pub users: i32,
    pub threads: i32,
    pub turns: i32,
    pub credits: f64,
    pub uncached_input: Option<i64>,
    pub cached_input: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub clients: Value,
    pub models: Value,
    pub model_shares: Value,
    pub surfaces: Value,
    pub settled: bool,
}

pub async fn upsert_daily_usage(
    pool: &PgPool,
    account_id: Uuid,
    d: &DailyUsageUpsert,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO account_daily_usage (account_id, day, users, threads, turns, credits, uncached_input, cached_input,
            output_tokens, total_tokens, clients, models, model_shares, surfaces, settled, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (account_id, day) DO UPDATE SET users = EXCLUDED.users, threads = EXCLUDED.threads,
            turns = EXCLUDED.turns, credits = EXCLUDED.credits, uncached_input = EXCLUDED.uncached_input,
            cached_input = EXCLUDED.cached_input, output_tokens = EXCLUDED.output_tokens,
            total_tokens = EXCLUDED.total_tokens, clients = EXCLUDED.clients, models = EXCLUDED.models,
            model_shares = CASE WHEN jsonb_array_length(EXCLUDED.model_shares) > 0 THEN EXCLUDED.model_shares ELSE account_daily_usage.model_shares END,
            surfaces = CASE WHEN EXCLUDED.surfaces <> '{}'::jsonb THEN EXCLUDED.surfaces ELSE account_daily_usage.surfaces END,
            settled = EXCLUDED.settled, synced_at = now()",
    )
    .bind(account_id)
    .bind(d.day)
    .bind(d.users)
    .bind(d.threads)
    .bind(d.turns)
    .bind(d.credits)
    .bind(d.uncached_input)
    .bind(d.cached_input)
    .bind(d.output_tokens)
    .bind(d.total_tokens)
    .bind(&d.clients)
    .bind(&d.models)
    .bind(&d.model_shares)
    .bind(&d.surfaces)
    .bind(d.settled)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_daily_usage(
    pool: &PgPool,
    account_id: Uuid,
    since: Option<NaiveDate>,
) -> sqlx::Result<Vec<DailyUsage>> {
    sqlx::query_as::<_, DailyUsage>(
        "SELECT * FROM account_daily_usage WHERE account_id = $1 AND ($2::date IS NULL OR day >= $2) ORDER BY day",
    )
    .bind(account_id)
    .bind(since)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DailySync {
    pub account_id: Uuid,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub backfilled: bool,
}

pub async fn get_daily_sync(pool: &PgPool, account_id: Uuid) -> sqlx::Result<Option<DailySync>> {
    sqlx::query_as::<_, DailySync>("SELECT * FROM account_daily_sync WHERE account_id = $1")
        .bind(account_id)
        .fetch_optional(pool)
        .await
}

pub async fn set_daily_sync(
    pool: &PgPool,
    account_id: Uuid,
    error: Option<&str>,
    ok: bool,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO account_daily_sync (account_id, last_sync_at, last_error, backfilled)
         VALUES ($1, now(), $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET last_sync_at = now(), last_error = EXCLUDED.last_error,
           backfilled = account_daily_sync.backfilled OR EXCLUDED.backfilled",
    )
    .bind(account_id)
    .bind(error)
    .bind(ok)
    .execute(pool)
    .await?;
    Ok(())
}

/// Official credits summed over everything retained locally, per account
/// (the amber "official" pill in the account list).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct OfficialTotals {
    pub account_id: Uuid,
    pub credits: f64,
    pub credits_7d: f64,
    pub days: i64,
    pub last_day: Option<NaiveDate>,
    pub synced_at: Option<DateTime<Utc>>,
}

pub async fn official_totals(pool: &PgPool) -> sqlx::Result<Vec<OfficialTotals>> {
    sqlx::query_as::<_, OfficialTotals>(
        "SELECT account_id, coalesce(sum(credits),0)::float8 AS credits,
                coalesce(sum(credits) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 6),0)::float8 AS credits_7d,
                count(*) AS days, max(day) AS last_day, max(synced_at) AS synced_at
         FROM account_daily_usage GROUP BY account_id",
    )
    .fetch_all(pool)
    .await
}
