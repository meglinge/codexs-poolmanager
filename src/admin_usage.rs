//! Admin API for the per-account usage panel: gateway-side statistics
//! (`usage_events`), the official quota snapshot and official daily usage,
//! and the health strip for the account list.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use chrono::Duration;
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::control;
use crate::db;
use crate::state::AppState;
use crate::wham;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/accounts/health", get(accounts_health))
        .route("/accounts/{id}/usage", get(account_usage))
        .route("/accounts/{id}/usage/requests", get(account_requests))
        .route("/accounts/{id}/quota", get(account_quota))
        .route("/accounts/{id}/quota/refresh", post(account_quota_refresh))
        .route("/accounts/{id}/official", get(account_official))
        .route("/accounts/{id}/official/sync", post(account_official_sync))
        .route(
            "/accounts/{id}/reset-credits/consume",
            post(account_consume_reset_credit),
        )
        .route("/pricing", get(pricing))
}

fn api_err(status: StatusCode, msg: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": msg.to_string() }))).into_response()
}

fn internal(e: impl std::fmt::Display) -> Response {
    api_err(StatusCode::INTERNAL_SERVER_ERROR, e)
}

#[derive(Deserialize)]
struct RangeQuery {
    /// `7d`, `30d`, `90d`, `24h`, `all` or a number of days.
    #[serde(default = "default_range")]
    range: String,
    #[serde(default = "default_tz")]
    tz: String,
}
fn default_range() -> String {
    "7d".to_string()
}
fn default_tz() -> String {
    "Asia/Shanghai".to_string()
}

fn range_days(range: &str) -> Option<i64> {
    let r = range.trim().to_ascii_lowercase();
    if r == "all" {
        return None;
    }
    if let Some(h) = r.strip_suffix('h') {
        return h.parse::<i64>().ok().map(|h| (h + 23) / 24);
    }
    r.trim_end_matches('d').parse::<i64>().ok()
}

fn scope(id: Uuid, q: &RangeQuery) -> db::UsageScope {
    let since = match q.range.trim().to_ascii_lowercase().strip_suffix('h') {
        Some(h) => h
            .parse::<i64>()
            .ok()
            .map(|h| Utc::now() - Duration::hours(h)),
        None => range_days(&q.range).map(|d| Utc::now() - Duration::days(d)),
    };
    let tz = if q
        .tz
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
    {
        q.tz.clone()
    } else {
        default_tz()
    };
    db::UsageScope {
        account_id: id,
        since,
        tz,
    }
}

/// Everything the panel's overview needs in one round trip.
async fn account_usage(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<RangeQuery>,
) -> Response {
    let account = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let s = scope(id, &q);
    let (totals, by_day, by_hour, by_model, by_key, by_status, by_endpoint, quota) = tokio::join!(
        db::account_totals(&st.db, &s),
        db::account_by_day(&st.db, &s),
        db::account_by_hour(&st.db, id, 48),
        db::account_by_model(&st.db, &s),
        db::account_by_key(&st.db, &s),
        db::account_by_status(&st.db, &s),
        db::account_by_endpoint(&st.db, &s),
        db::get_quota(&st.db, id),
    );
    let out = (|| -> sqlx::Result<serde_json::Value> {
        Ok(json!({
            "account": {
                "id": account.id, "name": account.name, "status": account.status, "enabled": account.enabled,
                "runner_id": account.runner_id, "port": account.port, "proxy_url": account.proxy_url,
                "max_concurrency": account.max_concurrency, "rpm_limit": account.rpm_limit,
                "chatgpt_account_id": account.chatgpt_account_id(), "created_at": account.created_at,
            },
            "range": q.range, "tz": s.tz, "since": s.since,
            "totals": totals?,
            "by_day": by_day?,
            "by_hour": by_hour?,
            "by_model": by_model?,
            "by_key": by_key?,
            "by_status": by_status?,
            "by_endpoint": by_endpoint?,
            "quota": quota?,
        }))
    })();
    match out {
        Ok(v) => Json(v).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
struct RequestsQuery {
    #[serde(flatten)]
    range: RangeQuery,
    model: Option<String>,
    api_key_id: Option<Uuid>,
    #[serde(default)]
    errors_only: bool,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}
fn default_limit() -> i64 {
    50
}

async fn account_requests(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<RequestsQuery>,
) -> Response {
    let s = scope(id, &q.range);
    let f = db::RecentFilter {
        model: q.model.as_deref().filter(|m| !m.is_empty()),
        api_key_id: q.api_key_id,
        errors_only: q.errors_only,
        limit: q.limit.clamp(1, 500),
        offset: q.offset.max(0),
    };
    match db::account_recent(&st.db, &s, &f).await {
        Ok((rows, total)) => {
            Json(json!({ "rows": rows, "total": total, "limit": f.limit, "offset": f.offset }))
                .into_response()
        }
        Err(e) => internal(e),
    }
}

async fn account_quota(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    match db::get_quota(&st.db, id).await {
        Ok(q) => Json(json!({ "quota": q })).into_response(),
        Err(e) => internal(e),
    }
}

async fn account_quota_refresh(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    let account = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    match wham::sync_quota(&st, &account).await {
        Ok(q) => Json(json!({ "quota": q })).into_response(),
        Err(e) => api_err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

#[derive(Deserialize)]
struct DaysQuery {
    #[serde(default = "default_days")]
    days: i64,
}
fn default_days() -> i64 {
    90
}

async fn account_official(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<DaysQuery>,
) -> Response {
    let since = (q.days > 0).then(|| (Utc::now() - Duration::days(q.days - 1)).date_naive());
    let (days, sync) = tokio::join!(
        db::list_daily_usage(&st.db, id, since),
        db::get_daily_sync(&st.db, id)
    );
    match (days, sync) {
        (Ok(days), Ok(sync)) => Json(json!({
            "days": days,
            "sync": sync,
            "credits_per_usd": wham::CREDITS_PER_USD,
            "source": wham::DAILY_URL,
        }))
        .into_response(),
        (Err(e), _) | (_, Err(e)) => internal(e),
    }
}

async fn account_official_sync(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<DaysQuery>,
) -> Response {
    let account = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let end = Utc::now().date_naive();
    let days = q.days.clamp(1, wham::DAILY_BACKFILL_DAYS);
    let start = end - Duration::days(days - 1);
    match wham::sync_daily(&st, &account, start, end).await {
        Ok(n) => {
            let _ = db::set_daily_sync(&st.db, id, None, days >= wham::DAILY_BACKFILL_DAYS).await;
            Json(json!({ "ok": true, "days": n })).into_response()
        }
        Err(e) => {
            let _ = db::set_daily_sync(&st.db, id, Some(&format!("{e:#}")), false).await;
            api_err(StatusCode::BAD_GATEWAY, format!("{e:#}"))
        }
    }
}

async fn account_consume_reset_credit(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Response {
    let account = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    // Refuse locally when the last probe says there is nothing to redeem.
    if let Ok(Some(q)) = db::get_quota(&st.db, id).await
        && q.ok
        && q.reset_credits_available <= 0
    {
        return api_err(StatusCode::CONFLICT, "no reset credits available");
    }
    let redeem_id = Uuid::new_v4().to_string();
    match st.wham.consume_reset_credit(&account, &redeem_id).await {
        Ok(f) if f.status == 200 => {
            // Re-probe so the panel shows the reset windows immediately.
            let quota = wham::sync_quota(&st, &account).await.ok();
            Json(json!({ "ok": true, "result": f.body, "quota": quota })).into_response()
        }
        Ok(f) => api_err(
            StatusCode::BAD_GATEWAY,
            format!("upstream returned {}: {}", f.status, f.body),
        ),
        Err(e) => api_err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

#[derive(Deserialize)]
struct HealthQuery {
    #[serde(default = "default_bucket")]
    bucket_minutes: i64,
    #[serde(default = "default_buckets")]
    buckets: i64,
}
fn default_bucket() -> i64 {
    10
}
fn default_buckets() -> i64 {
    20
}

/// Per-account strip data for the account list: success/failure buckets,
/// 7-day counters and the official quota snapshot.
async fn accounts_health(
    State(st): State<Arc<AppState>>,
    Query(q): Query<HealthQuery>,
) -> Response {
    let bucket_minutes = q.bucket_minutes.clamp(1, 1440);
    let buckets = q.buckets.clamp(1, 288);
    let (hb, counters, quotas, official) = tokio::join!(
        db::health_buckets(&st.db, bucket_minutes, buckets),
        db::account_counters(&st.db),
        db::list_quotas(&st.db),
        db::official_totals(&st.db),
    );
    let (hb, counters, quotas, official) = match (hb, counters, quotas, official) {
        (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
        (Err(e), _, _, _) | (_, Err(e), _, _) | (_, _, Err(e), _) | (_, _, _, Err(e)) => {
            return internal(e);
        }
    };
    let official: HashMap<Uuid, &db::OfficialTotals> =
        official.iter().map(|o| (o.account_id, o)).collect();
    let mut by_account: HashMap<Uuid, Vec<&db::HealthBucket>> = HashMap::new();
    for b in &hb {
        by_account.entry(b.account_id).or_default().push(b);
    }
    let counters: HashMap<Uuid, &db::AccountCounters> =
        counters.iter().map(|c| (c.account_id, c)).collect();
    let quotas: HashMap<Uuid, &db::AccountQuota> =
        quotas.iter().map(|q| (q.account_id, q)).collect();
    Json(json!({
        "bucket_minutes": bucket_minutes,
        "buckets": buckets,
        "now": Utc::now(),
        "health": by_account,
        "counters": counters,
        "quota": quotas,
        "official": official,
        "credits_per_usd": wham::CREDITS_PER_USD,
    }))
    .into_response()
}

async fn pricing() -> Response {
    Json(json!({ "usd_per_1m_tokens": crate::pricing::table() })).into_response()
}
