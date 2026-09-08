//! Account lifecycle operations shared by the admin API and background jobs.

use std::time::Duration;

use anyhow::Context;
use tracing::info;
use tracing::warn;
use uuid::Uuid;

use crate::db;
use crate::db::Account;
use crate::runner_api::StartRequest;
use crate::state::AppState;

/// Ask the account's runner to start its codexs instance and mark it `starting`.
pub async fn start_account(st: &AppState, account: &Account) -> anyhow::Result<()> {
    let runner = db::get_runner(&st.db, &account.runner_id)
        .await?
        .with_context(|| format!("runner {} not found", account.runner_id))?;
    anyhow::ensure!(!account.auth_json.is_null(), "account has no auth.json");
    let req = StartRequest {
        port: account.port as u16,
        proxy_url: account.proxy_url.clone(),
        auth_json: account.auth_json.clone(),
    };
    match st
        .runners
        .start(&runner, &account.id.to_string(), &req)
        .await
    {
        Ok(info) => {
            db::set_account_status(
                &st.db,
                account.id,
                "starting",
                info.pid.map(|p| p as i32),
                None,
            )
            .await?;
            info!(account = %account.name, pid = ?info.pid, "start requested");
            Ok(())
        }
        Err(e) => {
            db::set_account_status(&st.db, account.id, "error", None, Some(&format!("{e:#}")))
                .await?;
            Err(e)
        }
    }
}

pub async fn stop_account(st: &AppState, account: &Account) -> anyhow::Result<()> {
    if let Some(runner) = db::get_runner(&st.db, &account.runner_id).await?
        && let Err(e) = st.runners.stop(&runner, &account.id.to_string()).await
    {
        warn!(account = %account.name, "stop failed: {e:#}");
    }
    db::set_account_status(&st.db, account.id, "stopped", None, None).await?;
    Ok(())
}

/// Probe the instance's `/v1/models`; `Ok(())` means it answers.
pub async fn probe_instance(st: &AppState, url: &str) -> anyhow::Result<()> {
    let resp = st
        .runners_http()
        .get(format!("{url}/v1/models"))
        .timeout(Duration::from_secs(8))
        .send()
        .await?;
    anyhow::ensure!(resp.status().is_success(), "status {}", resp.status());
    Ok(())
}

/// Pull the (possibly refreshed) auth.json back from the runner into Postgres
/// so a restart on another runner keeps working tokens.
pub async fn sync_auth_from_runner(st: &AppState, account: &Account) -> anyhow::Result<bool> {
    let Some(runner) = db::get_runner(&st.db, &account.runner_id).await? else {
        return Ok(false);
    };
    let fresh = st.runners.auth(&runner, &account.id.to_string()).await?;
    if fresh != account.auth_json {
        db::set_account_auth(&st.db, account.id, &fresh).await?;
        return Ok(true);
    }
    Ok(false)
}

pub async fn find_account(st: &AppState, id: Uuid) -> anyhow::Result<Account> {
    db::get_account(&st.db, id)
        .await?
        .context("account not found")
}
