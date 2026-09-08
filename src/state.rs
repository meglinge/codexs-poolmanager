//! Shared state of a `serve` replica.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;
use std::time::Duration;

use sqlx::PgPool;
use tracing::warn;
use uuid::Uuid;

use crate::cache::Cache;
use crate::config::ServeConfig;
use crate::db;
use crate::db::Account;
use crate::db::Runner;
use crate::runner_client::RunnerClient;

pub struct AppState {
    pub cfg: ServeConfig,
    pub db: PgPool,
    pub cache: Cache,
    pub http: reqwest::Client,
    pub runners: RunnerClient,
    /// Official ChatGPT usage endpoints, one client per outbound proxy.
    pub wham: crate::wham::WhamClient,
    control: reqwest::Client,
    /// Routing snapshot refreshed by `refresh_loop`, so the hot path never
    /// waits on Postgres.
    snapshot: RwLock<Arc<Snapshot>>,
}

#[derive(Default)]
pub struct Snapshot {
    pub accounts: Vec<Account>,
    pub runners: HashMap<String, Runner>,
}

impl Snapshot {
    /// Base URL of the codexs instance serving `account`.
    pub fn instance_url(&self, account: &Account) -> Option<String> {
        self.runners
            .get(&account.runner_id)
            .map(|r| format!("http://{}:{}", r.public_host, account.port))
    }

    pub fn account(&self, id: Uuid) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }
}

impl AppState {
    pub async fn new(cfg: ServeConfig) -> anyhow::Result<Arc<Self>> {
        let db = db::connect(&cfg.database_url).await?;
        let cache = Cache::connect(&cfg.redis_url).await?;
        cache.ping().await?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(cfg.upstream_timeout_secs))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;
        let control = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()?;
        let state = Arc::new(Self {
            cfg,
            db,
            cache,
            http,
            runners: RunnerClient::new(control.clone()),
            wham: crate::wham::WhamClient::default(),
            control,
            snapshot: RwLock::new(Arc::new(Snapshot::default())),
        });
        state.refresh().await?;
        Ok(state)
    }

    /// Short-timeout client for control-plane calls (health probes).
    pub fn runners_http(&self) -> &reqwest::Client {
        &self.control
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(&self.snapshot.read().expect("snapshot lock"))
    }

    pub async fn refresh(&self) -> anyhow::Result<()> {
        let accounts = db::list_accounts(&self.db).await?;
        let runners = db::list_runners(&self.db)
            .await?
            .into_iter()
            .map(|r| (r.id.clone(), r))
            .collect();
        *self.snapshot.write().expect("snapshot lock") = Arc::new(Snapshot { accounts, runners });
        Ok(())
    }

    pub fn spawn_refresh_loop(self: &Arc<Self>, every: Duration) {
        let st = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if let Err(e) = st.refresh().await {
                    warn!("snapshot refresh failed: {e:#}");
                }
            }
        });
    }
}
