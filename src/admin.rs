//! Admin API (cookie session, single admin token) and the embedded UI.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::http::header;
use axum::middleware;
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::control;
use crate::db;
use crate::state::AppState;
use crate::util::random_token;
use crate::util::secret_eq;
use crate::util::sha256_hex;

const SESSION_COOKIE: &str = "pm_session";
const SESSION_TTL_SECS: u64 = 12 * 3600;

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/overview", get(overview))
        .route("/accounts", get(list_accounts).post(create_account))
        .route(
            "/accounts/{id}",
            get(get_account).put(update_account).delete(delete_account),
        )
        .route("/accounts/{id}/start", post(start_account))
        .route("/accounts/{id}/stop", post(stop_account))
        .route("/accounts/{id}/restart", post(restart_account))
        .route("/accounts/{id}/logs", get(account_logs))
        .route("/keys", get(list_keys).post(create_key))
        .route(
            "/keys/{id}",
            axum::routing::put(update_key).delete(delete_key),
        )
        .route("/runners", get(list_runners).post(upsert_runner))
        .route("/runners/{id}", axum::routing::delete(delete_runner))
        .route("/usage/summary", get(usage_summary))
        .route("/usage/recent", get(usage_recent))
        .merge(crate::admin_usage::routes())
        .merge(crate::admin_deploy::routes())
        .route("/logout", post(logout))
        .route("/auth/logout", post(auth_logout))
        .route("/auth/status", get(auth_status))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ))
        .route("/login", post(login))
        .route("/auth/login", post(auth_login))
        .route("/me", get(me));
    Router::new()
        .nest("/admin/api", api)
        .route("/admin", get(crate::ui::index))
        .route("/admin/", get(crate::ui::index))
        .route("/admin/{*path}", get(crate::ui::asset))
        .with_state(state)
}

fn api_err(status: StatusCode, msg: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": msg.to_string() }))).into_response()
}

fn internal(e: impl std::fmt::Display) -> Response {
    api_err(StatusCode::INTERNAL_SERVER_ERROR, e)
}

fn session_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .map(str::trim)
        .find_map(|kv| {
            kv.strip_prefix(&format!("{SESSION_COOKIE}="))
                .map(str::to_string)
        })
}

async fn require_session(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    // Bearer: either the admin token itself (scripts) or a session token
    // issued by /auth/login (the SPA keeps it in localStorage).
    if let Some(b) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|b| !b.is_empty())
        && (secret_eq(b, &st.cfg.admin_token)
            || st
                .cache
                .session_valid(b, SESSION_TTL_SECS)
                .await
                .unwrap_or(false))
    {
        return next.run(req).await;
    }
    match session_id(&headers) {
        Some(sid)
            if st
                .cache
                .session_valid(&sid, SESSION_TTL_SECS)
                .await
                .unwrap_or(false) =>
        {
            next.run(req).await
        }
        _ => api_err(StatusCode::UNAUTHORIZED, "login required"),
    }
}

#[derive(Deserialize)]
struct LoginBody {
    token: String,
}

async fn login(State(st): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> Response {
    if !secret_eq(&body.token, &st.cfg.admin_token) {
        return api_err(StatusCode::UNAUTHORIZED, "wrong token");
    }
    match st.cache.session_create(SESSION_TTL_SECS).await {
        Ok(sid) => {
            let cookie = format!(
                "{SESSION_COOKIE}={sid}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL_SECS}"
            );
            ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response()
        }
        Err(e) => internal(e),
    }
}

async fn logout(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(sid) = session_id(&headers) {
        let _ = st.cache.session_delete(&sid).await;
    }
    let cookie = format!("{SESSION_COOKIE}=; Path=/admin; HttpOnly; Max-Age=0");
    ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response()
}

/// Template-style auth: the SPA stores the returned session token and sends
/// it as `Authorization: Bearer`.
async fn auth_login(State(st): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> Response {
    if !secret_eq(&body.token, &st.cfg.admin_token) {
        return api_err(StatusCode::UNAUTHORIZED, "token 不正确");
    }
    match st.cache.session_create(SESSION_TTL_SECS).await {
        Ok(sid) => Json(json!({ "token": sid })).into_response(),
        Err(e) => internal(e),
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
}

async fn auth_logout(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(sid) = bearer_token(&headers) {
        let _ = st.cache.session_delete(&sid).await;
    }
    Json(json!({ "ok": true })).into_response()
}

async fn auth_status(State(st): State<Arc<AppState>>) -> Response {
    // Reaching here means require_session accepted the bearer.
    Json(json!({ "authenticated": true, "instance": st.cfg.instance_id, "version": env!("CARGO_PKG_VERSION") })).into_response()
}

async fn me(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let ok = match session_id(&headers) {
        Some(sid) => st
            .cache
            .session_valid(&sid, SESSION_TTL_SECS)
            .await
            .unwrap_or(false),
        None => false,
    };
    Json(json!({ "authenticated": ok, "instance": st.cfg.instance_id, "version": env!("CARGO_PKG_VERSION") })).into_response()
}

// ---- overview ---------------------------------------------------------------

async fn overview(State(st): State<Arc<AppState>>) -> Response {
    let accounts = match db::list_accounts(&st.db).await {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    let mut rows = Vec::with_capacity(accounts.len());
    let mut running = 0;
    for a in &accounts {
        let inflight = st.cache.inflight_get("acct", a.id).await.unwrap_or(0);
        if a.status == "running" {
            running += 1;
        }
        rows.push(json!({
            "id": a.id, "name": a.name, "status": a.status, "enabled": a.enabled,
            "runner_id": a.runner_id, "port": a.port, "inflight": inflight,
            "max_concurrency": a.max_concurrency, "last_error": a.last_error,
            "chatgpt_account_id": a.chatgpt_account_id(),
        }));
    }
    let runners = db::list_runners(&st.db).await.unwrap_or_default();
    Json(json!({
        "instance": st.cfg.instance_id,
        "version": env!("CARGO_PKG_VERSION"),
        "accounts_total": accounts.len(),
        "accounts_running": running,
        "runners": runners.len(),
        "accounts": rows,
    }))
    .into_response()
}

// ---- accounts ----------------------------------------------------------------

async fn list_accounts(State(st): State<Arc<AppState>>) -> Response {
    match db::list_accounts(&st.db).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_account(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    match db::get_account(&st.db, id).await {
        Ok(Some(a)) => {
            let mut v = serde_json::to_value(&a).unwrap_or_default();
            v["chatgpt_account_id"] = json!(a.chatgpt_account_id());
            v["has_auth"] = json!(!a.auth_json.is_null());
            Json(v).into_response()
        }
        Ok(None) => api_err(StatusCode::NOT_FOUND, "not found"),
        Err(e) => internal(e),
    }
}

#[allow(clippy::result_large_err)]
fn validate_account(a: &db::AccountInput) -> Result<(), Response> {
    if a.name.trim().is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "name is required"));
    }
    if !(1..=65535).contains(&a.port) {
        return Err(api_err(StatusCode::BAD_REQUEST, "port must be 1-65535"));
    }
    if let Some(v) = &a.auth_json
        && v.pointer("/tokens/access_token")
            .and_then(|t| t.as_str())
            .is_none()
    {
        return Err(api_err(
            StatusCode::BAD_REQUEST,
            "auth_json must contain tokens.access_token",
        ));
    }
    Ok(())
}

async fn create_account(
    State(st): State<Arc<AppState>>,
    Json(input): Json<db::AccountInput>,
) -> Response {
    if let Err(r) = validate_account(&input) {
        return r;
    }
    if input.auth_json.is_none() {
        return api_err(StatusCode::BAD_REQUEST, "auth_json is required");
    }
    match db::insert_account(&st.db, &input).await {
        Ok(a) => {
            let _ = st.refresh().await;
            (StatusCode::CREATED, Json(a)).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn update_account(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(input): Json<db::AccountInput>,
) -> Response {
    if let Err(r) = validate_account(&input) {
        return r;
    }
    match db::update_account(&st.db, id, &input).await {
        Ok(Some(a)) => {
            let _ = st.refresh().await;
            Json(a).into_response()
        }
        Ok(None) => api_err(StatusCode::NOT_FOUND, "not found"),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn delete_account(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    if let Ok(Some(a)) = db::get_account(&st.db, id).await {
        let _ = control::stop_account(&st, &a).await;
    }
    match db::delete_account(&st.db, id).await {
        Ok(0) => api_err(StatusCode::NOT_FOUND, "not found"),
        Ok(_) => {
            let _ = st.refresh().await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => internal(e),
    }
}

async fn start_account(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    let a = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    match control::start_account(&st, &a).await {
        Ok(()) => {
            let _ = st.refresh().await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

async fn stop_account(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    let a = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    match control::stop_account(&st, &a).await {
        Ok(()) => {
            let _ = st.refresh().await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

async fn restart_account(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    let a = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let _ = control::stop_account(&st, &a).await;
    match control::start_account(&st, &a).await {
        Ok(()) => {
            let _ = st.refresh().await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

#[derive(Deserialize)]
struct TailQuery {
    #[serde(default = "default_tail")]
    tail: usize,
}
fn default_tail() -> usize {
    200
}

async fn account_logs(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<TailQuery>,
) -> Response {
    let a = match control::find_account(&st, id).await {
        Ok(a) => a,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let runner = match db::get_runner(&st.db, &a.runner_id).await {
        Ok(Some(r)) => r,
        _ => return api_err(StatusCode::NOT_FOUND, "runner not found"),
    };
    match st
        .runners
        .logs(&runner, &a.id.to_string(), q.tail.min(5000))
        .await
    {
        Ok(text) => text.into_response(),
        Err(e) => api_err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

// ---- api keys ------------------------------------------------------------------

async fn list_keys(State(st): State<Arc<AppState>>) -> Response {
    match db::list_api_keys(&st.db).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => internal(e),
    }
}

async fn create_key(
    State(st): State<Arc<AppState>>,
    Json(input): Json<db::ApiKeyInput>,
) -> Response {
    if input.name.trim().is_empty() {
        return api_err(StatusCode::BAD_REQUEST, "name is required");
    }
    let secret = format!("pm-{}", random_token(40));
    let hash = sha256_hex(&secret);
    let prefix: String = secret.chars().take(12).collect();
    match db::insert_api_key(&st.db, &input, &hash, &prefix).await {
        Ok(k) => {
            let mut v = serde_json::to_value(&k).unwrap_or_default();
            v["key"] = json!(secret); // shown exactly once
            (StatusCode::CREATED, Json(v)).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn update_key(
    State(st): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(input): Json<db::ApiKeyInput>,
) -> Response {
    match db::update_api_key(&st.db, id, &input).await {
        Ok(Some(k)) => Json(k).into_response(),
        Ok(None) => api_err(StatusCode::NOT_FOUND, "not found"),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn delete_key(State(st): State<Arc<AppState>>, Path(id): Path<Uuid>) -> Response {
    match db::delete_api_key(&st.db, id).await {
        Ok(0) => api_err(StatusCode::NOT_FOUND, "not found"),
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => internal(e),
    }
}

// ---- runners -------------------------------------------------------------------

async fn list_runners(State(st): State<Arc<AppState>>) -> Response {
    let runners = match db::list_runners(&st.db).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let mut out = Vec::with_capacity(runners.len());
    for r in &runners {
        let health = st.runners.health(r).await.ok();
        let mut v = serde_json::to_value(r).unwrap_or_default();
        v["online"] = json!(health.is_some());
        v["instances"] = json!(health.as_ref().map(|h| h.instances));
        v["runner_version"] = json!(health.as_ref().map(|h| h.version.clone()));
        v["codexs_bin"] = json!(health.as_ref().map(|h| h.codexs_bin.clone()));
        out.push(v);
    }
    Json(out).into_response()
}

async fn upsert_runner(
    State(st): State<Arc<AppState>>,
    Json(input): Json<db::RunnerInput>,
) -> Response {
    if input.id.trim().is_empty()
        || !input
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return api_err(StatusCode::BAD_REQUEST, "id must be alphanumeric/-/_");
    }
    match db::upsert_runner(&st.db, &input).await {
        Ok(r) => {
            let _ = st.refresh().await;
            Json(r).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn delete_runner(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    match db::delete_runner(&st.db, &id).await {
        Ok(0) => api_err(StatusCode::NOT_FOUND, "not found"),
        Ok(_) => {
            let _ = st.refresh().await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => api_err(StatusCode::CONFLICT, e),
    }
}

// ---- usage ----------------------------------------------------------------------

#[derive(Deserialize)]
struct RangeQuery {
    #[serde(default = "default_hours")]
    hours: i64,
}
fn default_hours() -> i64 {
    24
}

async fn usage_summary(State(st): State<Arc<AppState>>, Query(q): Query<RangeQuery>) -> Response {
    let hours = q.hours.clamp(1, 24 * 90);
    let by_key = db::usage_by_api_key(&st.db, hours).await;
    let by_account = db::usage_by_account(&st.db, hours).await;
    match (by_key, by_account) {
        (Ok(k), Ok(a)) => {
            Json(json!({ "hours": hours, "by_key": k, "by_account": a })).into_response()
        }
        (Err(e), _) | (_, Err(e)) => internal(e),
    }
}

#[derive(Deserialize)]
struct LimitQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}
fn default_limit() -> i64 {
    100
}

async fn usage_recent(State(st): State<Arc<AppState>>, Query(q): Query<LimitQuery>) -> Response {
    match db::recent_usage(&st.db, q.limit.clamp(1, 1000)).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => internal(e),
    }
}
