//! Aggregations over `usage_events` for one account (the account usage panel)
//! and the per-account health buckets shown in the account list.

use chrono::DateTime;
use chrono::NaiveDate;
use chrono::Utc;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

/// Range + timezone the panel asks for. Days are bucketed in `tz` so "today"
/// matches the operator's calendar, not UTC.
#[derive(Debug, Clone)]
pub struct UsageScope {
    pub account_id: Uuid,
    pub since: Option<DateTime<Utc>>,
    pub tz: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct UsageTotals {
    pub requests: i64,
    pub success: i64,
    pub errors: i64,
    pub client_aborts: i64,
    pub cached_hits: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
    pub avg_latency_ms: f64,
    pub p50_latency_ms: f64,
    pub p95_latency_ms: f64,
    pub avg_ttft_ms: Option<f64>,
    pub p50_ttft_ms: Option<f64>,
    pub streams: i64,
    pub first_ts: Option<DateTime<Utc>>,
    pub last_ts: Option<DateTime<Utc>>,
}

pub async fn account_totals(pool: &PgPool, s: &UsageScope) -> sqlx::Result<UsageTotals> {
    sqlx::query_as::<_, UsageTotals>(
        "SELECT count(*) AS requests,
                count(*) FILTER (WHERE status < 400) AS success,
                count(*) FILTER (WHERE status >= 400) AS errors,
                count(*) FILTER (WHERE error = 'client disconnected') AS client_aborts,
                count(*) FILTER (WHERE cached_tokens > 0) AS cached_hits,
                coalesce(sum(input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(cached_tokens),0)::bigint AS cached_tokens,
                coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens,
                coalesce(sum(cost_usd),0)::float8 AS cost_usd,
                coalesce(avg(latency_ms),0)::float8 AS avg_latency_ms,
                coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),0)::float8 AS p50_latency_ms,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),0)::float8 AS p95_latency_ms,
                avg(ttft_ms)::float8 AS avg_ttft_ms,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms))::float8 AS p50_ttft_ms,
                count(*) FILTER (WHERE stream) AS streams,
                min(ts) AS first_ts, max(ts) AS last_ts
         FROM usage_events WHERE account_id = $1 AND ($2::timestamptz IS NULL OR ts >= $2)",
    )
    .bind(s.account_id)
    .bind(s.since)
    .fetch_one(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DayStat {
    pub day: NaiveDate,
    pub requests: i64,
    pub errors: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
    pub avg_latency_ms: f64,
}

pub async fn account_by_day(pool: &PgPool, s: &UsageScope) -> sqlx::Result<Vec<DayStat>> {
    sqlx::query_as::<_, DayStat>(
        "SELECT (ts AT TIME ZONE $3)::date AS day, count(*) AS requests,
                count(*) FILTER (WHERE status >= 400) AS errors,
                coalesce(sum(input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(cached_tokens),0)::bigint AS cached_tokens,
                coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens,
                coalesce(sum(cost_usd),0)::float8 AS cost_usd,
                coalesce(avg(latency_ms),0)::float8 AS avg_latency_ms
         FROM usage_events WHERE account_id = $1 AND ($2::timestamptz IS NULL OR ts >= $2)
         GROUP BY 1 ORDER BY 1",
    )
    .bind(s.account_id)
    .bind(s.since)
    .bind(&s.tz)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct HourStat {
    pub hour: DateTime<Utc>,
    pub requests: i64,
    pub errors: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

/// Hourly buckets, always the last `hours` hours (for the "recent activity" strip).
pub async fn account_by_hour(
    pool: &PgPool,
    account_id: Uuid,
    hours: i64,
) -> sqlx::Result<Vec<HourStat>> {
    sqlx::query_as::<_, HourStat>(
        "SELECT date_trunc('hour', ts) AS hour, count(*) AS requests,
                count(*) FILTER (WHERE status >= 400) AS errors,
                coalesce(sum(input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(cost_usd),0)::float8 AS cost_usd
         FROM usage_events WHERE account_id = $1 AND ts >= now() - ($2 * interval '1 hour')
         GROUP BY 1 ORDER BY 1",
    )
    .bind(account_id)
    .bind(hours as f64)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ModelStat {
    pub model: Option<String>,
    pub requests: i64,
    pub errors: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
    pub avg_latency_ms: f64,
    pub avg_ttft_ms: Option<f64>,
    pub last_ts: Option<DateTime<Utc>>,
}

pub async fn account_by_model(pool: &PgPool, s: &UsageScope) -> sqlx::Result<Vec<ModelStat>> {
    sqlx::query_as::<_, ModelStat>(
        "SELECT model, count(*) AS requests,
                count(*) FILTER (WHERE status >= 400) AS errors,
                coalesce(sum(input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(cached_tokens),0)::bigint AS cached_tokens,
                coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens,
                coalesce(sum(cost_usd),0)::float8 AS cost_usd,
                coalesce(avg(latency_ms),0)::float8 AS avg_latency_ms,
                avg(ttft_ms)::float8 AS avg_ttft_ms,
                max(ts) AS last_ts
         FROM usage_events WHERE account_id = $1 AND ($2::timestamptz IS NULL OR ts >= $2)
         GROUP BY model ORDER BY requests DESC",
    )
    .bind(s.account_id)
    .bind(s.since)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct KeyStat {
    pub api_key_id: Option<Uuid>,
    pub name: Option<String>,
    pub key_prefix: Option<String>,
    pub requests: i64,
    pub errors: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cost_usd: f64,
    pub avg_latency_ms: f64,
    pub last_ts: Option<DateTime<Utc>>,
}

pub async fn account_by_key(pool: &PgPool, s: &UsageScope) -> sqlx::Result<Vec<KeyStat>> {
    sqlx::query_as::<_, KeyStat>(
        "SELECT u.api_key_id, k.name, k.key_prefix, count(*) AS requests,
                count(*) FILTER (WHERE u.status >= 400) AS errors,
                coalesce(sum(u.input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(u.output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(u.cached_tokens),0)::bigint AS cached_tokens,
                coalesce(sum(u.cost_usd),0)::float8 AS cost_usd,
                coalesce(avg(u.latency_ms),0)::float8 AS avg_latency_ms,
                max(u.ts) AS last_ts
         FROM usage_events u LEFT JOIN api_keys k ON k.id = u.api_key_id
         WHERE u.account_id = $1 AND ($2::timestamptz IS NULL OR u.ts >= $2)
         GROUP BY u.api_key_id, k.name, k.key_prefix ORDER BY requests DESC",
    )
    .bind(s.account_id)
    .bind(s.since)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct StatusStat {
    pub status: i32,
    pub requests: i64,
    pub last_error: Option<String>,
    pub last_ts: Option<DateTime<Utc>>,
}

pub async fn account_by_status(pool: &PgPool, s: &UsageScope) -> sqlx::Result<Vec<StatusStat>> {
    sqlx::query_as::<_, StatusStat>(
        "SELECT status, count(*) AS requests,
                (array_agg(error ORDER BY ts DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error,
                max(ts) AS last_ts
         FROM usage_events WHERE account_id = $1 AND ($2::timestamptz IS NULL OR ts >= $2)
         GROUP BY status ORDER BY status",
    )
    .bind(s.account_id)
    .bind(s.since)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct EndpointStat {
    pub path: String,
    pub stream: bool,
    pub requests: i64,
    pub errors: i64,
    pub avg_latency_ms: f64,
    pub avg_ttft_ms: Option<f64>,
}

pub async fn account_by_endpoint(pool: &PgPool, s: &UsageScope) -> sqlx::Result<Vec<EndpointStat>> {
    sqlx::query_as::<_, EndpointStat>(
        "SELECT path, stream, count(*) AS requests,
                count(*) FILTER (WHERE status >= 400) AS errors,
                coalesce(avg(latency_ms),0)::float8 AS avg_latency_ms,
                avg(ttft_ms)::float8 AS avg_ttft_ms
         FROM usage_events WHERE account_id = $1 AND ($2::timestamptz IS NULL OR ts >= $2)
         GROUP BY path, stream ORDER BY requests DESC",
    )
    .bind(s.account_id)
    .bind(s.since)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RecentRow {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub api_key_id: Option<Uuid>,
    pub key_name: Option<String>,
    pub path: String,
    pub status: i32,
    pub latency_ms: i32,
    pub ttft_ms: Option<i32>,
    pub stream: bool,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
    pub error: Option<String>,
}

pub struct RecentFilter<'a> {
    pub model: Option<&'a str>,
    pub api_key_id: Option<Uuid>,
    pub errors_only: bool,
    pub limit: i64,
    pub offset: i64,
}

pub async fn account_recent(
    pool: &PgPool,
    s: &UsageScope,
    f: &RecentFilter<'_>,
) -> sqlx::Result<(Vec<RecentRow>, i64)> {
    let rows = sqlx::query_as::<_, RecentRow>(
        "SELECT u.id, u.ts, u.api_key_id, k.name AS key_name, u.path, u.status, u.latency_ms, u.ttft_ms, u.stream,
                u.model, u.service_tier, u.input_tokens, u.output_tokens, u.cached_tokens, u.reasoning_tokens,
                u.cost_usd, u.error
         FROM usage_events u LEFT JOIN api_keys k ON k.id = u.api_key_id
         WHERE u.account_id = $1 AND ($2::timestamptz IS NULL OR u.ts >= $2)
           AND ($3::text IS NULL OR u.model = $3)
           AND ($4::uuid IS NULL OR u.api_key_id = $4)
           AND (NOT $5 OR u.status >= 400)
         ORDER BY u.id DESC LIMIT $6 OFFSET $7",
    )
    .bind(s.account_id)
    .bind(s.since)
    .bind(f.model)
    .bind(f.api_key_id)
    .bind(f.errors_only)
    .bind(f.limit)
    .bind(f.offset)
    .fetch_all(pool)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM usage_events u
         WHERE u.account_id = $1 AND ($2::timestamptz IS NULL OR u.ts >= $2)
           AND ($3::text IS NULL OR u.model = $3)
           AND ($4::uuid IS NULL OR u.api_key_id = $4)
           AND (NOT $5 OR u.status >= 400)",
    )
    .bind(s.account_id)
    .bind(s.since)
    .bind(f.model)
    .bind(f.api_key_id)
    .bind(f.errors_only)
    .fetch_one(pool)
    .await?;
    Ok((rows, total))
}

/// Success / failure counts per `bucket_minutes` bucket for every account,
/// newest `buckets` buckets. Feeds the health bars in the account list.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct HealthBucket {
    pub account_id: Uuid,
    pub bucket: DateTime<Utc>,
    pub success: i64,
    pub failed: i64,
}

pub async fn health_buckets(
    pool: &PgPool,
    bucket_minutes: i64,
    buckets: i64,
) -> sqlx::Result<Vec<HealthBucket>> {
    sqlx::query_as::<_, HealthBucket>(
        "SELECT account_id,
                to_timestamp(floor(extract(epoch FROM ts) / ($1 * 60)) * ($1 * 60)) AS bucket,
                count(*) FILTER (WHERE status < 400) AS success,
                count(*) FILTER (WHERE status >= 400) AS failed
         FROM usage_events
         WHERE account_id IS NOT NULL AND ts >= now() - ($1 * $2 * interval '1 minute')
         GROUP BY account_id, 2 ORDER BY account_id, 2",
    )
    .bind(bucket_minutes as f64)
    .bind(buckets as f64)
    .fetch_all(pool)
    .await
}

/// Quick per-account counters for the account list (7d requests, 24h cost).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AccountCounters {
    pub account_id: Uuid,
    pub requests_7d: i64,
    pub errors_7d: i64,
    pub requests_24h: i64,
    pub cost_7d: f64,
    pub cost_5h: f64,
    pub tokens_7d: i64,
    pub last_ts: Option<DateTime<Utc>>,
}

pub async fn account_counters(pool: &PgPool) -> sqlx::Result<Vec<AccountCounters>> {
    sqlx::query_as::<_, AccountCounters>(
        "SELECT account_id, count(*) AS requests_7d,
                count(*) FILTER (WHERE status >= 400) AS errors_7d,
                count(*) FILTER (WHERE ts >= now() - interval '24 hours') AS requests_24h,
                coalesce(sum(cost_usd),0)::float8 AS cost_7d,
                coalesce(sum(cost_usd) FILTER (WHERE ts >= now() - interval '5 hours'),0)::float8 AS cost_5h,
                coalesce(sum(input_tokens + output_tokens),0)::bigint AS tokens_7d,
                max(ts) AS last_ts
         FROM usage_events WHERE account_id IS NOT NULL AND ts >= now() - interval '7 days'
         GROUP BY account_id",
    )
    .fetch_all(pool)
    .await
}
