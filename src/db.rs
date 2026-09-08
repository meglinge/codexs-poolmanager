//! Postgres access: models and queries. All state that must survive a
//! manager restart or be shared between replicas lives here.

use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub async fn connect(url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .connect(url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

// ---------------------------------------------------------------------------
// runners

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Runner {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(skip_serializing)]
    pub token: String,
    pub public_host: String,
    pub last_seen: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct RunnerInput {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub token: String,
    pub public_host: String,
}

pub async fn list_runners(pool: &PgPool) -> sqlx::Result<Vec<Runner>> {
    sqlx::query_as::<_, Runner>("SELECT * FROM runners ORDER BY id")
        .fetch_all(pool)
        .await
}

pub async fn get_runner(pool: &PgPool, id: &str) -> sqlx::Result<Option<Runner>> {
    sqlx::query_as::<_, Runner>("SELECT * FROM runners WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn upsert_runner(pool: &PgPool, r: &RunnerInput) -> sqlx::Result<Runner> {
    sqlx::query_as::<_, Runner>(
        "INSERT INTO runners (id, name, base_url, token, public_host) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url,
           token = EXCLUDED.token, public_host = EXCLUDED.public_host
         RETURNING *",
    )
    .bind(&r.id)
    .bind(&r.name)
    .bind(&r.base_url)
    .bind(&r.token)
    .bind(&r.public_host)
    .fetch_one(pool)
    .await
}

pub async fn delete_runner(pool: &PgPool, id: &str) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM runners WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected())
}

pub async fn touch_runner(pool: &PgPool, id: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE runners SET last_seen = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// accounts

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Account {
    pub id: Uuid,
    pub name: String,
    pub runner_id: String,
    pub port: i32,
    pub proxy_url: Option<String>,
    #[serde(skip_serializing)]
    pub auth_json: serde_json::Value,
    pub max_concurrency: i32,
    pub rpm_limit: Option<i32>,
    pub enabled: bool,
    pub status: String,
    pub pid: Option<i32>,
    pub last_health: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Account {
    /// ChatGPT account id recorded in the stored auth.json, if any.
    pub fn chatgpt_account_id(&self) -> Option<String> {
        self.auth_json
            .get("tokens")
            .and_then(|t| t.get("account_id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }
}

#[derive(Debug, Deserialize)]
pub struct AccountInput {
    pub name: String,
    pub runner_id: String,
    pub port: i32,
    pub proxy_url: Option<String>,
    /// Full auth.json content. Optional on update (keeps the stored one).
    pub auth_json: Option<serde_json::Value>,
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: i32,
    pub rpm_limit: Option<i32>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_max_concurrency() -> i32 {
    4
}
fn default_true() -> bool {
    true
}

pub async fn list_accounts(pool: &PgPool) -> sqlx::Result<Vec<Account>> {
    sqlx::query_as::<_, Account>("SELECT * FROM accounts ORDER BY created_at")
        .fetch_all(pool)
        .await
}

pub async fn get_account(pool: &PgPool, id: Uuid) -> sqlx::Result<Option<Account>> {
    sqlx::query_as::<_, Account>("SELECT * FROM accounts WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn insert_account(pool: &PgPool, a: &AccountInput) -> sqlx::Result<Account> {
    sqlx::query_as::<_, Account>(
        "INSERT INTO accounts (id, name, runner_id, port, proxy_url, auth_json, max_concurrency, rpm_limit, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(&a.name)
    .bind(&a.runner_id)
    .bind(a.port)
    .bind(&a.proxy_url)
    .bind(a.auth_json.clone().unwrap_or(serde_json::Value::Null))
    .bind(a.max_concurrency)
    .bind(a.rpm_limit)
    .bind(a.enabled)
    .fetch_one(pool)
    .await
}

pub async fn update_account(
    pool: &PgPool,
    id: Uuid,
    a: &AccountInput,
) -> sqlx::Result<Option<Account>> {
    sqlx::query_as::<_, Account>(
        "UPDATE accounts SET name = $2, runner_id = $3, port = $4, proxy_url = $5,
            auth_json = COALESCE($6, auth_json), max_concurrency = $7, rpm_limit = $8,
            enabled = $9, updated_at = now()
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(&a.name)
    .bind(&a.runner_id)
    .bind(a.port)
    .bind(&a.proxy_url)
    .bind(a.auth_json.clone())
    .bind(a.max_concurrency)
    .bind(a.rpm_limit)
    .bind(a.enabled)
    .fetch_optional(pool)
    .await
}

pub async fn delete_account(pool: &PgPool, id: Uuid) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM accounts WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected())
}

pub async fn set_account_status(
    pool: &PgPool,
    id: Uuid,
    status: &str,
    pid: Option<i32>,
    error: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE accounts SET status = $2, pid = $3, last_error = $4, last_health = now(), updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(pid)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_account_auth(
    pool: &PgPool,
    id: Uuid,
    auth_json: &serde_json::Value,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE accounts SET auth_json = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(auth_json)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// api keys

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ApiKey {
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub key_hash: String,
    pub key_prefix: String,
    pub max_concurrency: Option<i32>,
    pub rpm_limit: Option<i32>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct ApiKeyInput {
    pub name: String,
    pub max_concurrency: Option<i32>,
    pub rpm_limit: Option<i32>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

pub async fn list_api_keys(pool: &PgPool) -> sqlx::Result<Vec<ApiKey>> {
    sqlx::query_as::<_, ApiKey>("SELECT * FROM api_keys ORDER BY created_at")
        .fetch_all(pool)
        .await
}

pub async fn find_api_key_by_hash(pool: &PgPool, hash: &str) -> sqlx::Result<Option<ApiKey>> {
    sqlx::query_as::<_, ApiKey>("SELECT * FROM api_keys WHERE key_hash = $1")
        .bind(hash)
        .fetch_optional(pool)
        .await
}

pub async fn insert_api_key(
    pool: &PgPool,
    k: &ApiKeyInput,
    hash: &str,
    prefix: &str,
) -> sqlx::Result<ApiKey> {
    sqlx::query_as::<_, ApiKey>(
        "INSERT INTO api_keys (id, name, key_hash, key_prefix, max_concurrency, rpm_limit, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(&k.name)
    .bind(hash)
    .bind(prefix)
    .bind(k.max_concurrency)
    .bind(k.rpm_limit)
    .bind(k.enabled)
    .fetch_one(pool)
    .await
}

pub async fn update_api_key(
    pool: &PgPool,
    id: Uuid,
    k: &ApiKeyInput,
) -> sqlx::Result<Option<ApiKey>> {
    sqlx::query_as::<_, ApiKey>(
        "UPDATE api_keys SET name = $2, max_concurrency = $3, rpm_limit = $4, enabled = $5
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(&k.name)
    .bind(k.max_concurrency)
    .bind(k.rpm_limit)
    .bind(k.enabled)
    .fetch_optional(pool)
    .await
}

pub async fn delete_api_key(pool: &PgPool, id: Uuid) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM api_keys WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected())
}

pub async fn touch_api_key(pool: &PgPool, id: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// usage

#[derive(Debug, Clone)]
pub struct UsageEvent {
    pub api_key_id: Option<Uuid>,
    pub account_id: Option<Uuid>,
    pub path: String,
    pub status: i32,
    pub latency_ms: i32,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub error: Option<String>,
}

pub async fn insert_usage(pool: &PgPool, e: &UsageEvent) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO usage_events (api_key_id, account_id, path, status, latency_ms, input_tokens, output_tokens, cached_tokens, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(e.api_key_id)
    .bind(e.account_id)
    .bind(&e.path)
    .bind(e.status)
    .bind(e.latency_ms)
    .bind(e.input_tokens)
    .bind(e.output_tokens)
    .bind(e.cached_tokens)
    .bind(&e.error)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UsageBucket {
    pub key: Option<Uuid>,
    pub name: Option<String>,
    pub requests: i64,
    pub errors: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub avg_latency_ms: f64,
}

pub async fn usage_by_api_key(pool: &PgPool, hours: i64) -> sqlx::Result<Vec<UsageBucket>> {
    sqlx::query_as::<_, UsageBucket>(
        "SELECT u.api_key_id AS key, k.name AS name, count(*) AS requests,
                count(*) FILTER (WHERE u.status >= 400) AS errors,
                coalesce(sum(u.input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(u.output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(u.cached_tokens),0)::bigint AS cached_tokens,
                coalesce(avg(u.latency_ms),0)::float8 AS avg_latency_ms
         FROM usage_events u LEFT JOIN api_keys k ON k.id = u.api_key_id
         WHERE u.ts > now() - ($1 * interval '1 hour')
         GROUP BY u.api_key_id, k.name ORDER BY requests DESC",
    )
    .bind(hours as f64)
    .fetch_all(pool)
    .await
}

pub async fn usage_by_account(pool: &PgPool, hours: i64) -> sqlx::Result<Vec<UsageBucket>> {
    sqlx::query_as::<_, UsageBucket>(
        "SELECT u.account_id AS key, a.name AS name, count(*) AS requests,
                count(*) FILTER (WHERE u.status >= 400) AS errors,
                coalesce(sum(u.input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(u.output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(u.cached_tokens),0)::bigint AS cached_tokens,
                coalesce(avg(u.latency_ms),0)::float8 AS avg_latency_ms
         FROM usage_events u LEFT JOIN accounts a ON a.id = u.account_id
         WHERE u.ts > now() - ($1 * interval '1 hour')
         GROUP BY u.account_id, a.name ORDER BY requests DESC",
    )
    .bind(hours as f64)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UsageRow {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub api_key_id: Option<Uuid>,
    pub account_id: Option<Uuid>,
    pub path: String,
    pub status: i32,
    pub latency_ms: i32,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub error: Option<String>,
}

pub async fn recent_usage(pool: &PgPool, limit: i64) -> sqlx::Result<Vec<UsageRow>> {
    sqlx::query_as::<_, UsageRow>("SELECT * FROM usage_events ORDER BY id DESC LIMIT $1")
        .bind(limit)
        .fetch_all(pool)
        .await
}

pub async fn prune_usage(pool: &PgPool, days: i64) -> sqlx::Result<u64> {
    Ok(
        sqlx::query("DELETE FROM usage_events WHERE ts < now() - ($1 * interval '1 day')")
            .bind(days as f64)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}
