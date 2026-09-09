//! Admin proxy to the A/B deployment control service (`deploy/control_server.py`).
//! The browser never sees the deployment token: the manager forwards the few
//! fixed actions with its own credentials. Unconfigured = `{"enabled": false}`.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

const MAX_BODY: usize = 4096;
const ACTIONS: &[&str] = &["deploy", "switch", "rollback", "resume", "runner"];

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/deployment", get(status))
        .route("/deployment/releases", get(releases))
        .route("/deployment/{action}", post(action))
}

fn target(st: &AppState) -> Option<(String, String)> {
    let url = st.cfg.deploy_url.as_deref()?.trim().trim_end_matches('/');
    let token = st.cfg.deploy_token.as_deref()?.trim();
    (!url.is_empty() && !token.is_empty()).then(|| (url.to_string(), token.to_string()))
}

async fn forward(
    st: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Bytes>,
) -> Result<(StatusCode, Bytes), String> {
    let (url, token) = target(st).ok_or_else(|| "deployment service not configured".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .request(method, format!("{url}{path}"))
        .bearer_auth(token)
        .header(header::ACCEPT, "application/json");
    if let Some(b) = body {
        req = req.header(header::CONTENT_TYPE, "application/json").body(b);
    }
    let resp = req.send().await.map_err(|e| summarize(&e))?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let bytes = resp.bytes().await.map_err(|e| summarize(&e))?;
    Ok((status, bytes))
}

fn summarize(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "connection refused".to_string()
    } else if e.is_timeout() {
        "timeout".to_string()
    } else {
        e.to_string()
    }
}

/// Pass the controller's JSON through; wrap anything that is not JSON.
fn passthrough(status: StatusCode, body: Bytes, add_enabled: bool) -> Response {
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(mut v) => {
            if add_enabled && v.is_object() {
                v["enabled"] = json!(true);
            }
            (status, Json(v)).into_response()
        }
        Err(_) => (
            status,
            Json(json!({ "error": String::from_utf8_lossy(&body).chars().take(300).collect::<String>() })),
        )
            .into_response(),
    }
}

async fn status(State(st): State<Arc<AppState>>) -> Response {
    if target(&st).is_none() {
        return Json(json!({ "enabled": false })).into_response();
    }
    match forward(&st, reqwest::Method::GET, "/status", None).await {
        Ok((s, b)) => passthrough(s, b, true),
        Err(e) => Json(json!({ "enabled": true, "error": format!("部署控制服务不可达:{e}") }))
            .into_response(),
    }
}

#[derive(Deserialize)]
struct ReleasesQuery {
    #[serde(default)]
    refresh: Option<String>,
}

async fn releases(State(st): State<Arc<AppState>>, Query(q): Query<ReleasesQuery>) -> Response {
    if target(&st).is_none() {
        return Json(json!({ "enabled": false })).into_response();
    }
    let path = if q.refresh.as_deref() == Some("1") {
        "/releases?refresh=1"
    } else {
        "/releases"
    };
    match forward(&st, reqwest::Method::GET, path, None).await {
        Ok((s, b)) => passthrough(s, b, true),
        Err(e) => Json(json!({
            "enabled": true,
            "error": format!("部署控制服务不可达:{e}"),
            "releases": [], "updateAvailable": false, "running": {}
        }))
        .into_response(),
    }
}

async fn action(
    State(st): State<Arc<AppState>>,
    Path(action): Path<String>,
    body: Bytes,
) -> Response {
    let action = action.trim().to_ascii_lowercase();
    if !ACTIONS.contains(&action.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "unknown action" })),
        )
            .into_response();
    }
    if target(&st).is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "A/B deployment service not configured (PM_DEPLOY_URL / PM_DEPLOY_TOKEN)" })),
        )
            .into_response();
    }
    if body.len() > MAX_BODY {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "body too large" })),
        )
            .into_response();
    }
    let body = if body.iter().all(u8::is_ascii_whitespace) {
        Bytes::from_static(b"{}")
    } else {
        body
    };
    if !serde_json::from_slice::<serde_json::Value>(&body)
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "body must be a JSON object" })),
        )
            .into_response();
    }
    match forward(
        &st,
        reqwest::Method::POST,
        &format!("/{action}"),
        Some(body),
    )
    .await
    {
        Ok((s, b)) => passthrough(s, b, false),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("部署控制服务不可达:{e}") })),
        )
            .into_response(),
    }
}
