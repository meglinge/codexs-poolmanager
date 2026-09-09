//! poolmanager: gateway + supervisor + admin UI for a pool of `codexs server`
//! instances (one Codex account per instance).
//!
//! Roles (same binary):
//!   poolmanager serve   -- stateless gateway/admin replica (run 2 behind HAProxy)
//!   poolmanager runner  -- starts/stops codexs processes on a host

mod admin;
mod admin_deploy;
mod admin_usage;
mod cache;
mod config;
mod control;
mod db;
mod gateway;
mod jobs;
mod pricing;
mod runner;
mod runner_api;
mod runner_client;
mod state;
mod ui;
mod util;
mod wham;

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::get;
use clap::Parser;
use clap::Subcommand;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[derive(Parser, Debug)]
#[command(name = "poolmanager", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Gateway + admin API/UI replica.
    Serve(config::ServeConfig),
    /// Process supervisor for codexs instances on this host.
    Runner(config::RunnerConfig),
    /// Print a random secret (for PM_ADMIN_TOKEN / PM_RUNNER_TOKEN).
    GenSecret,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
    match Cli::parse().command {
        Command::Serve(cfg) => serve(cfg).await,
        Command::Runner(cfg) => runner::run(cfg).await,
        Command::GenSecret => {
            println!("{}", util::random_token(48));
            Ok(())
        }
    }
}

async fn serve(cfg: config::ServeConfig) -> anyhow::Result<()> {
    let listen = cfg.listen.clone();
    let state = AppState::new(cfg).await?;
    state.spawn_refresh_loop(Duration::from_secs(5));
    jobs::spawn(Arc::clone(&state));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .with_state(Arc::clone(&state))
        .merge(gateway::router(Arc::clone(&state)))
        .merge(admin::router(Arc::clone(&state)))
        .layer(TraceLayer::new_for_http());
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    info!(listen = %listen, instance = %state.cfg.instance_id, "poolmanager serving");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("shutdown requested");
        })
        .await?;
    Ok(())
}

async fn healthz(State(st): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let redis_ok = st.cache.ping().await.is_ok();
    let db_ok = sqlx::query("SELECT 1").execute(&st.db).await.is_ok();
    Json(serde_json::json!({
        "ok": redis_ok && db_ok,
        "instance": st.cfg.instance_id,
        "version": env!("CARGO_PKG_VERSION"),
        "redis": redis_ok,
        "db": db_ok,
    }))
}

/// HAProxy / compose readiness: 503 unless Postgres and Redis both answer.
/// (`/healthz` is liveness and always 200 with the details.)
async fn readyz(State(st): State<Arc<AppState>>) -> axum::response::Response {
    use axum::response::IntoResponse;
    let redis_ok = st.cache.ping().await.is_ok();
    let db_ok = sqlx::query("SELECT 1").execute(&st.db).await.is_ok();
    let active = st.cache.active_slot().await.ok().flatten();
    let body = Json(serde_json::json!({
        "ok": redis_ok && db_ok,
        "instance": st.cfg.instance_id,
        "active_slot": active,
        "version": env!("CARGO_PKG_VERSION"),
        "redis": redis_ok,
        "db": db_ok,
    }));
    if redis_ok && db_ok {
        body.into_response()
    } else {
        (axum::http::StatusCode::SERVICE_UNAVAILABLE, body).into_response()
    }
}
