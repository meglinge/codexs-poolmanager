//! Background jobs run by whichever replica currently holds the Redis
//! leader lock: health checks, reconciliation (enabled accounts should be
//! running, disabled ones stopped), auth.json sync and usage pruning.

use std::sync::Arc;
use std::time::Duration;

use tracing::info;
use tracing::warn;

use crate::control;
use crate::db;
use crate::state::AppState;

/// Is this replica's slot the active one? Absent marker = no A/B distinction.
pub async fn slot_active(st: &AppState) -> bool {
    match st.cache.active_slot().await {
        Ok(Some(active)) => active == st.cfg.instance_id,
        _ => true,
    }
}

pub fn spawn(st: Arc<AppState>) {
    tokio::spawn(async move {
        let interval = Duration::from_secs(st.cfg.health_interval_secs.max(5));
        // Holder is `<slot>-<pid>`: the deployment controller reads the slot
        // prefix to know which replica still leads while it quiesces.
        let holder = format!("{}-{}", st.cfg.instance_id, std::process::id());
        let mut ticks: u64 = 0;
        let mut was_leader = false;
        loop {
            // A/B (Android-style single active slot): the standby replica
            // stays up and ready but never competes for the leader lock, and
            // gives the lock back within seconds when traffic is switched away.
            if !slot_active(&st).await {
                if was_leader {
                    let _ = st.cache.leader_release(&holder).await;
                    info!(slot = %st.cfg.instance_id, "slot no longer active; released leadership");
                    was_leader = false;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let leader = st
                .cache
                .leader_acquire(&holder, (interval.as_millis() as u64) * 3)
                .await
                .unwrap_or(false);
            if leader {
                if !was_leader {
                    info!(slot = %st.cfg.instance_id, "leading background jobs");
                }
                was_leader = true;
                if let Err(e) = tick(&st, ticks).await {
                    warn!("background tick failed: {e:#}");
                }
                ticks += 1;
            } else {
                was_leader = false;
            }
            tokio::time::sleep(interval).await;
        }
    });
}

async fn tick(st: &Arc<AppState>, ticks: u64) -> anyhow::Result<()> {
    let accounts = db::list_accounts(&st.db).await?;
    let runners = db::list_runners(&st.db).await?;

    // Runner liveness + which instances they actually run.
    let mut running_ids: Vec<String> = Vec::new();
    for r in &runners {
        match st.runners.list(r).await {
            Ok(list) => {
                let _ = db::touch_runner(&st.db, &r.id).await;
                running_ids.extend(list.into_iter().filter(|i| i.running).map(|i| i.id));
            }
            Err(e) => warn!(runner = %r.id, "runner unreachable: {e:#}"),
        }
    }

    for a in &accounts {
        let id = a.id.to_string();
        let is_running = running_ids.contains(&id);
        let snap = st.snapshot();
        let url = snap.instance_url(a);
        if a.enabled {
            if !is_running {
                if a.status != "error" || ticks.is_multiple_of(4) {
                    // Not running (never started, crashed, or runner restarted): start it.
                    info!(account = %a.name, status = %a.status, "instance not running; starting");
                    if let Err(e) = control::start_account(st, a).await {
                        warn!(account = %a.name, "start failed: {e:#}");
                    }
                }
                continue;
            }
            match url {
                Some(url) => match control::probe_instance(st, &url).await {
                    Ok(()) => {
                        if a.status != "running" {
                            info!(account = %a.name, "healthy");
                        }
                        db::set_account_status(&st.db, a.id, "running", a.pid, None).await?;
                    }
                    Err(e) => {
                        let status = if a.status == "starting" {
                            "starting"
                        } else {
                            "unhealthy"
                        };
                        db::set_account_status(
                            &st.db,
                            a.id,
                            status,
                            a.pid,
                            Some(&format!("{e:#}")),
                        )
                        .await?;
                    }
                },
                None => {
                    db::set_account_status(&st.db, a.id, "error", None, Some("runner not found"))
                        .await?;
                }
            }
            // Codex refreshes tokens on disk; keep Postgres current (every ~4 ticks).
            if ticks.is_multiple_of(4)
                && let Ok(true) = control::sync_auth_from_runner(st, a).await
            {
                info!(account = %a.name, "auth.json synced from runner");
            }
        } else if is_running || a.status != "stopped" {
            info!(account = %a.name, "disabled; stopping");
            if let Err(e) = control::stop_account(st, a).await {
                warn!(account = %a.name, "stop failed: {e:#}");
            }
        }
    }

    // Official quota (5h / 7d windows) once a minute-ish per enabled account,
    // official daily usage once an hour (deep backfill the first time).
    // Both are zero-cost upstream calls made through the account's proxy.
    if ticks.is_multiple_of(4) && slot_active(st).await {
        let hourly = ticks.is_multiple_of(240);
        for a in accounts
            .iter()
            .filter(|a| a.enabled && !a.auth_json.is_null())
        {
            if let Err(e) = crate::wham::sync_quota(st, a).await {
                warn!(account = %a.name, "quota probe failed: {e:#}");
            }
            let needs_backfill = matches!(
                db::get_daily_sync(&st.db, a.id).await,
                Ok(None)
                    | Ok(Some(db::DailySync {
                        backfilled: false,
                        ..
                    }))
            );
            if hourly || needs_backfill {
                crate::wham::sync_daily_job(st, a).await;
            }
        }
    }

    // Prune usage once an hour-ish.
    if ticks.is_multiple_of(240) {
        match db::prune_usage(&st.db, st.cfg.usage_retention_days).await {
            Ok(n) if n > 0 => info!(rows = n, "pruned usage events"),
            Ok(_) => {}
            Err(e) => warn!("usage prune failed: {e}"),
        }
    }
    st.refresh().await?;
    Ok(())
}
