//! Official ChatGPT backend usage endpoints (`/backend-api/wham/…`). They cost
//! no quota and are what the Codex CLI itself uses for its `/status` view:
//!
//! * `usage`: live 5h / 7d windows, plan, credits, reset credits
//! * `analytics/daily-workspace-usage-counts`: settled per-day totals (credits,
//!   tokens) split by client and model
//! * `usage/daily-token-usage-breakdown`: per-day share per (model, speed)
//! * `rate-limit-reset-credits` (+ `/consume`): the "free reset" vouchers
//!
//! Requests go through the account's own outbound proxy so the traffic looks
//! like the codexs instance's.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Context as _;
use anyhow::anyhow;
use chrono::DateTime;
use chrono::Duration as ChronoDuration;
use chrono::NaiveDate;
use chrono::Utc;
use serde_json::Value;
use serde_json::json;
use tracing::info;
use tracing::warn;

use crate::db;
use crate::db::Account;
use crate::state::AppState;

pub const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
pub const DAILY_URL: &str =
    "https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts";
pub const BREAKDOWN_URL: &str =
    "https://chatgpt.com/backend-api/wham/usage/daily-token-usage-breakdown";
pub const RESET_CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
pub const RESET_CONSUME_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

/// Rolling window re-synced every hour (today and the days still settling).
pub const DAILY_WINDOW_DAYS: i64 = 7;
/// First sync per account pulls this much history (upstream keeps ~12 weeks).
pub const DAILY_BACKFILL_DAYS: i64 = 84;
/// Official credits → USD (1 USD = 25 credits, matches catalogue prices).
pub const CREDITS_PER_USD: f64 = 25.0;

fn user_agent() -> String {
    let ver = std::env::var("PM_CODEX_UA_VERSION").unwrap_or_else(|_| "0.153.4".to_string());
    format!("codex_cli_rs/{ver} (Linux; x86_64)")
}

/// One reqwest client per outbound proxy so connection pools are reused.
#[derive(Default)]
pub struct WhamClient {
    clients: Mutex<HashMap<String, reqwest::Client>>,
}

pub struct Fetched {
    pub status: u16,
    pub body: Value,
}

impl WhamClient {
    fn client(&self, proxy: Option<&str>) -> anyhow::Result<reqwest::Client> {
        let key = proxy.unwrap_or("").trim().to_string();
        let mut guard = self.clients.lock().expect("wham clients lock");
        if let Some(c) = guard.get(&key) {
            return Ok(c.clone());
        }
        let mut b = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(40))
            .pool_idle_timeout(Duration::from_secs(60))
            .user_agent(user_agent());
        if !key.is_empty() {
            b = b.proxy(reqwest::Proxy::all(&key).with_context(|| format!("proxy url {key}"))?);
        }
        let c = b.build()?;
        guard.insert(key, c.clone());
        Ok(c)
    }

    async fn call(
        &self,
        account: &Account,
        method: reqwest::Method,
        url: &str,
        query: &[(&str, String)],
    ) -> anyhow::Result<Fetched> {
        self.call_with_body(account, method, url, query, None).await
    }

    async fn call_with_body(
        &self,
        account: &Account,
        method: reqwest::Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> anyhow::Result<Fetched> {
        let token = account
            .auth_json
            .pointer("/tokens/access_token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("account has no access token"))?;
        let client = self.client(account.proxy_url.as_deref())?;
        let mut req = client
            .request(method, url)
            .query(query)
            .bearer_auth(token)
            .header("accept", "application/json")
            .header("originator", "codex_cli_rs");
        if let Some(id) = account.chatgpt_account_id() {
            req = req.header("chatgpt-account-id", id);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.context("request failed")?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let body = serde_json::from_str(&text)
            .unwrap_or_else(|_| json!({ "raw": text.chars().take(400).collect::<String>() }));
        Ok(Fetched { status, body })
    }

    pub async fn usage(&self, account: &Account) -> anyhow::Result<Fetched> {
        self.call(account, reqwest::Method::GET, USAGE_URL, &[])
            .await
    }

    pub async fn reset_credits(&self, account: &Account) -> anyhow::Result<Fetched> {
        self.call(account, reqwest::Method::GET, RESET_CREDITS_URL, &[])
            .await
    }

    /// `redeem_request_id` is the upstream idempotency key: retrying with the
    /// same id never burns a second voucher.
    pub async fn consume_reset_credit(
        &self,
        account: &Account,
        redeem_request_id: &str,
    ) -> anyhow::Result<Fetched> {
        self.call_with_body(
            account,
            reqwest::Method::POST,
            RESET_CONSUME_URL,
            &[],
            Some(json!({ "redeem_request_id": redeem_request_id })),
        )
        .await
    }

    pub async fn daily(
        &self,
        account: &Account,
        start: NaiveDate,
        end: NaiveDate,
    ) -> anyhow::Result<Fetched> {
        self.call(
            account,
            reqwest::Method::GET,
            DAILY_URL,
            &[
                ("start_date", start.to_string()),
                ("end_date", end.to_string()),
                ("group_by", "day".to_string()),
                ("workspace_user", "true".to_string()),
            ],
        )
        .await
    }

    pub async fn breakdown(
        &self,
        account: &Account,
        start: NaiveDate,
        end: NaiveDate,
    ) -> anyhow::Result<Fetched> {
        self.call(
            account,
            reqwest::Method::GET,
            BREAKDOWN_URL,
            &[
                ("start_date", start.to_string()),
                ("end_date", end.to_string()),
                ("group_by", "day".to_string()),
            ],
        )
        .await
    }
}

fn window(v: &Value, key: &str) -> (Option<f64>, Option<i64>, Option<DateTime<Utc>>) {
    let w = v.get(key);
    let Some(w) = w.filter(|w| !w.is_null()) else {
        return (None, None, None);
    };
    let used = w.get("used_percent").and_then(Value::as_f64);
    let secs = w.get("limit_window_seconds").and_then(Value::as_i64);
    let reset = w
        .get("reset_at")
        .and_then(Value::as_i64)
        .and_then(|t| DateTime::from_timestamp(t, 0))
        .or_else(|| {
            w.get("reset_after_seconds")
                .and_then(Value::as_i64)
                .map(|s| Utc::now() + ChronoDuration::seconds(s))
        });
    (used, secs, reset)
}

/// Turn a `/wham/usage` answer (and optionally the reset-credit list) into
/// the row stored in `account_quota`.
pub fn quota_from_usage(body: &Value, reset_list: Option<&Value>) -> db::QuotaUpsert {
    let rl = body.get("rate_limit").cloned().unwrap_or(Value::Null);
    let (p_used, p_secs, p_reset) = window(&rl, "primary_window");
    let (s_used, s_secs, s_reset) = window(&rl, "secondary_window");
    let additional = body
        .get("additional_rate_limits")
        .cloned()
        .filter(Value::is_array)
        .unwrap_or_else(|| json!([]));
    let credits = body.get("credits").cloned().filter(|v| !v.is_null());
    let rc = body.get("rate_limit_reset_credits");
    let reset_credits = reset_list
        .and_then(|l| l.get("credits"))
        .cloned()
        .filter(Value::is_array)
        .unwrap_or_else(|| json!([]));
    db::QuotaUpsert {
        ok: true,
        error: None,
        http_status: Some(200),
        plan_type: body
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        email: body
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        allowed: rl.get("allowed").and_then(Value::as_bool),
        limit_reached: rl.get("limit_reached").and_then(Value::as_bool),
        primary_used_percent: p_used,
        primary_window_seconds: p_secs,
        primary_reset_at: p_reset,
        secondary_used_percent: s_used,
        secondary_window_seconds: s_secs,
        secondary_reset_at: s_reset,
        additional_limits: additional,
        credits,
        reset_credits_available: rc
            .and_then(|r| r.get("available_count"))
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32,
        reset_credits_applicable: rc
            .and_then(|r| r.get("applicable_available_count"))
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32,
        reset_credits,
        raw: Some(body.clone()),
    }
}

/// Probe the live quota for one account and store the result (success or the
/// upstream error, so the UI can show why the numbers are stale).
pub async fn sync_quota(st: &Arc<AppState>, account: &Account) -> anyhow::Result<db::AccountQuota> {
    let row = match st.wham.usage(account).await {
        Ok(f) if f.status == 200 => {
            let resets = match st.wham.reset_credits(account).await {
                Ok(r) if r.status == 200 => Some(r.body),
                Ok(r) => {
                    warn!(account = %account.name, status = r.status, "reset credits list failed");
                    None
                }
                Err(e) => {
                    warn!(account = %account.name, "reset credits list failed: {e:#}");
                    None
                }
            };
            quota_from_usage(&f.body, resets.as_ref())
        }
        Ok(f) => db::QuotaUpsert::failed(
            Some(f.status as i32),
            format!("upstream returned {}: {}", f.status, brief(&f.body)),
        ),
        Err(e) => db::QuotaUpsert::failed(None, format!("{e:#}")),
    };
    db::upsert_quota(&st.db, account.id, &row).await?;
    db::get_quota(&st.db, account.id)
        .await?
        .ok_or_else(|| anyhow!("quota row missing after upsert"))
}

fn brief(v: &Value) -> String {
    let s = v
        .pointer("/detail")
        .or_else(|| v.pointer("/error/message"))
        .or_else(|| v.get("raw"))
        .map(|d| {
            d.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| d.to_string())
        })
        .unwrap_or_else(|| v.to_string());
    s.chars().take(200).collect()
}

/// Pull the official daily usage for `[start, end]` and merge the per-model
/// share for the same days; upserts one row per day that has data.
pub async fn sync_daily(
    st: &Arc<AppState>,
    account: &Account,
    start: NaiveDate,
    end: NaiveDate,
) -> anyhow::Result<usize> {
    let counts = st.wham.daily(account, start, end).await?;
    if counts.status != 200 {
        anyhow::bail!(
            "daily usage returned {}: {}",
            counts.status,
            brief(&counts.body)
        );
    }
    let shares: HashMap<String, (Value, Value)> = match st.wham.breakdown(account, start, end).await {
        Ok(f) if f.status == 200 => f
            .body
            .get("data")
            .and_then(Value::as_array)
            .map(|days| {
                days.iter()
                    .filter_map(|d| {
                        let date = d.get("date")?.as_str()?.to_string();
                        let models: Vec<Value> = d
                            .get("models")
                            .and_then(Value::as_array)
                            .map(|ms| {
                                ms.iter()
                                    .filter(|m| m.get("credits").and_then(Value::as_f64).unwrap_or(0.0) > 0.0)
                                    .map(|m| {
                                        json!({
                                            "model": m.get("model").and_then(Value::as_str).unwrap_or(""),
                                            "speed": m.get("speed").and_then(Value::as_str).unwrap_or("standard"),
                                            "percent": m.get("credits").and_then(Value::as_f64).unwrap_or(0.0),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let surfaces = d
                            .get("product_surface_usage_values")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        Some((date, (Value::Array(models), surfaces)))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Ok(f) => {
            warn!(account = %account.name, status = f.status, "token breakdown failed");
            HashMap::new()
        }
        Err(e) => {
            warn!(account = %account.name, "token breakdown failed: {e:#}");
            HashMap::new()
        }
    };

    let today = Utc::now().date_naive();
    let mut n = 0;
    for d in counts
        .body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(date) = d
            .get("date")
            .and_then(Value::as_str)
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        else {
            continue;
        };
        let t = d.get("totals").cloned().unwrap_or(Value::Null);
        let gi = |k: &str| t.get(k).and_then(Value::as_i64);
        let (model_shares, surfaces) = shares
            .get(&date.to_string())
            .cloned()
            .unwrap_or_else(|| (json!([]), json!({})));
        let row = db::DailyUsageUpsert {
            day: date,
            users: gi("users").unwrap_or(0) as i32,
            threads: gi("threads").unwrap_or(0) as i32,
            turns: gi("turns").unwrap_or(0) as i32,
            credits: t.get("credits").and_then(Value::as_f64).unwrap_or(0.0),
            uncached_input: gi("uncached_text_input_tokens"),
            cached_input: gi("cached_text_input_tokens"),
            output_tokens: gi("text_output_tokens"),
            total_tokens: gi("text_total_tokens"),
            clients: d
                .get("clients")
                .cloned()
                .filter(Value::is_array)
                .unwrap_or_else(|| json!([])),
            models: d
                .get("models")
                .cloned()
                .filter(Value::is_array)
                .unwrap_or_else(|| json!([])),
            model_shares,
            surfaces,
            settled: date < today && gi("text_total_tokens").is_some(),
        };
        db::upsert_daily_usage(&st.db, account.id, &row).await?;
        n += 1;
    }
    Ok(n)
}

/// Hourly job: rolling 7-day window, or a deep backfill the first time.
pub async fn sync_daily_job(st: &Arc<AppState>, account: &Account) {
    let state = db::get_daily_sync(&st.db, account.id).await.ok().flatten();
    let backfill = !state.as_ref().map(|s| s.backfilled).unwrap_or(false);
    let end = Utc::now().date_naive();
    let days = if backfill {
        DAILY_BACKFILL_DAYS
    } else {
        DAILY_WINDOW_DAYS
    };
    let start = end - ChronoDuration::days(days - 1);
    match sync_daily(st, account, start, end).await {
        Ok(n) => {
            info!(account = %account.name, days = n, backfill, "official daily usage synced");
            let _ = db::set_daily_sync(&st.db, account.id, None, true).await;
        }
        Err(e) => {
            warn!(account = %account.name, "official daily usage sync failed: {e:#}");
            let _ = db::set_daily_sync(&st.db, account.id, Some(&format!("{e:#}")), false).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_payload() {
        let body: Value = serde_json::from_str(
            r#"{"plan_type":"pro","email":"a@b.c","rate_limit":{"allowed":true,"limit_reached":false,
                "primary_window":{"used_percent":12.5,"limit_window_seconds":604800,"reset_after_seconds":100,"reset_at":1789481468},
                "secondary_window":null},
                "additional_rate_limits":[{"limit_name":"x"}],
                "credits":{"has_credits":true,"balance":"250"},
                "rate_limit_reset_credits":{"available_count":1,"applicable_available_count":0}}"#,
        )
        .unwrap();
        let q = quota_from_usage(&body, None);
        assert_eq!(q.plan_type.as_deref(), Some("pro"));
        assert_eq!(q.primary_used_percent, Some(12.5));
        assert_eq!(q.primary_window_seconds, Some(604800));
        assert_eq!(q.primary_reset_at.unwrap().timestamp(), 1789481468);
        assert!(q.secondary_used_percent.is_none());
        assert_eq!(q.reset_credits_available, 1);
        assert_eq!(q.additional_limits.as_array().unwrap().len(), 1);
    }
}
