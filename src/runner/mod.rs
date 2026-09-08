//! `poolmanager runner`: a small control API that starts and stops
//! `codexs server` processes on this host. It is deliberately dumb: the
//! manager decides *what* should run; the runner only executes.

mod supervisor;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::middleware;
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use serde::Deserialize;
use tracing::info;

use crate::config::RunnerConfig;
use crate::runner_api::RunnerHealth;
use crate::runner_api::StartRequest;
use crate::util::secret_eq;
use supervisor::Supervisor;

#[derive(Clone)]
struct RunnerState {
    cfg: Arc<RunnerConfig>,
    sup: Arc<Supervisor>,
}

pub async fn run(cfg: RunnerConfig) -> anyhow::Result<()> {
    std::fs::create_dir_all(cfg.data_dir.join("instances"))?;
    let state = RunnerState {
        sup: Arc::new(Supervisor::new(&cfg)),
        cfg: Arc::new(cfg),
    };
    let app = Router::new()
        .route("/instances", get(list))
        .route("/instances/{id}/start", post(start))
        .route("/instances/{id}/stop", post(stop))
        .route("/instances/{id}/logs", get(logs))
        .route("/instances/{id}/auth", get(auth))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
        .route("/healthz", get(healthz))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(&state.cfg.listen).await?;
    info!(listen = %state.cfg.listen, data_dir = %state.cfg.data_dir.display(), "runner listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    state.sup.shutdown().await;
    Ok(())
}

async fn require_token(
    State(st): State<RunnerState>,
    headers: HeaderMap,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !secret_eq(presented, &st.cfg.token) {
        return (StatusCode::UNAUTHORIZED, "invalid runner token").into_response();
    }
    next.run(req).await
}

async fn healthz(State(st): State<RunnerState>) -> Json<RunnerHealth> {
    Json(RunnerHealth {
        ok: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
        codexs_bin: st.cfg.codexs_bin.display().to_string(),
        instances: st.sup.list().await.len(),
    })
}

async fn list(State(st): State<RunnerState>) -> impl IntoResponse {
    Json(st.sup.list().await)
}

async fn start(
    State(st): State<RunnerState>,
    Path(id): Path<String>,
    Json(req): Json<StartRequest>,
) -> Response {
    match st.sup.start(&id, req).await {
        Ok(info) => Json(info).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

async fn stop(State(st): State<RunnerState>, Path(id): Path<String>) -> Response {
    match st.sup.stop(&id).await {
        Ok(stopped) => Json(serde_json::json!({ "stopped": stopped })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

#[derive(Deserialize)]
struct LogsQuery {
    #[serde(default = "default_tail")]
    tail: usize,
}
fn default_tail() -> usize {
    200
}

async fn logs(
    State(st): State<RunnerState>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> Response {
    match st.sup.logs(&id, q.tail).await {
        Ok(text) => text.into_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("{e:#}")).into_response(),
    }
}

async fn auth(State(st): State<RunnerState>, Path(id): Path<String>) -> Response {
    match st.sup.read_auth(&id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("{e:#}")).into_response(),
    }
}
