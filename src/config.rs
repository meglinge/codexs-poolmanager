//! Process configuration (CLI flags with `PM_*` environment fallbacks).

use std::path::PathBuf;

use clap::Args;

/// `poolmanager serve`: gateway + admin API/UI. Stateless; run several
/// replicas behind HAProxy and share Postgres + Redis.
#[derive(Args, Debug, Clone)]
pub struct ServeConfig {
    /// Listen address for the gateway and admin UI.
    #[arg(long, env = "PM_LISTEN", default_value = "0.0.0.0:8800")]
    pub listen: String,
    /// Postgres connection URL.
    #[arg(long, env = "PM_DATABASE_URL")]
    pub database_url: String,
    /// Redis URL.
    #[arg(long, env = "PM_REDIS_URL", default_value = "redis://127.0.0.1:6379")]
    pub redis_url: String,
    /// Admin login token for the management UI/API.
    #[arg(long, env = "PM_ADMIN_TOKEN", hide_env_values = true)]
    pub admin_token: String,
    /// Identifier of this replica (shown in /healthz and logs), e.g. `a` or `b`.
    #[arg(long, env = "PM_INSTANCE_ID", default_value = "a")]
    pub instance_id: String,
    /// Upstream request timeout for a whole gateway response (seconds).
    #[arg(long, env = "PM_UPSTREAM_TIMEOUT_SECS", default_value_t = 900)]
    pub upstream_timeout_secs: u64,
    /// How long a response id / session stays pinned to its account (seconds).
    #[arg(long, env = "PM_STICKY_TTL_SECS", default_value_t = 6 * 3600)]
    pub sticky_ttl_secs: u64,
    /// Seconds between health checks of running instances (leader replica only).
    #[arg(long, env = "PM_HEALTH_INTERVAL_SECS", default_value_t = 15)]
    pub health_interval_secs: u64,
    /// Days of usage_events to keep.
    #[arg(long, env = "PM_USAGE_RETENTION_DAYS", default_value_t = 30)]
    pub usage_retention_days: i64,
    /// A/B deployment control service (deploy/control_server.py), e.g.
    /// `http://deployment:16828`. Unset = the 部署 page shows "not enabled".
    #[arg(long, env = "PM_DEPLOY_URL")]
    pub deploy_url: Option<String>,
    /// Bearer token for the deployment control service (never sent to browsers).
    #[arg(long, env = "PM_DEPLOY_TOKEN", hide_env_values = true)]
    pub deploy_token: Option<String>,
}

/// `poolmanager runner`: supervises `codexs server` processes on this host.
#[derive(Args, Debug, Clone)]
pub struct RunnerConfig {
    /// Listen address for the runner control API.
    #[arg(long, env = "PM_RUNNER_LISTEN", default_value = "0.0.0.0:7000")]
    pub listen: String,
    /// Shared secret the manager must present as `Authorization: Bearer …`.
    #[arg(long, env = "PM_RUNNER_TOKEN", hide_env_values = true)]
    pub token: String,
    /// Directory for per-instance CODEX_HOMEs and logs.
    #[arg(long, env = "PM_RUNNER_DATA_DIR", default_value = "/data/runner")]
    pub data_dir: PathBuf,
    /// Path to the `codexs` binary.
    #[arg(long, env = "PM_CODEXS_BIN", default_value = "codexs")]
    pub codexs_bin: PathBuf,
    /// Address the spawned codexs instances bind to.
    #[arg(long, env = "PM_INSTANCE_BIND_HOST", default_value = "0.0.0.0")]
    pub instance_bind_host: String,
}
