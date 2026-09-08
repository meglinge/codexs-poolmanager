//! Process supervision for `codexs server` instances.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::Context;
use chrono::DateTime;
use chrono::Utc;
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::info;
use tracing::warn;

use crate::config::RunnerConfig;
use crate::runner_api::InstanceInfo;
use crate::runner_api::StartRequest;

struct Instance {
    port: u16,
    child: Option<Child>,
    pid: Option<u32>,
    started_at: DateTime<Utc>,
    exit_code: Arc<std::sync::Mutex<Option<i32>>>,
}

pub struct Supervisor {
    data_dir: PathBuf,
    codexs_bin: PathBuf,
    bind_host: String,
    instances: Mutex<HashMap<String, Instance>>,
}

fn safe_id(id: &str) -> anyhow::Result<&str> {
    anyhow::ensure!(
        !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "invalid instance id"
    );
    Ok(id)
}

impl Supervisor {
    pub fn new(cfg: &RunnerConfig) -> Self {
        Self {
            data_dir: cfg.data_dir.clone(),
            codexs_bin: cfg.codexs_bin.clone(),
            bind_host: cfg.instance_bind_host.clone(),
            instances: Mutex::new(HashMap::new()),
        }
    }

    fn dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("instances").join(id)
    }

    pub async fn list(&self) -> Vec<InstanceInfo> {
        let map = self.instances.lock().await;
        map.iter()
            .map(|(id, inst)| {
                let exit = *inst.exit_code.lock().expect("exit code lock");
                InstanceInfo {
                    id: id.clone(),
                    port: inst.port,
                    pid: inst.pid,
                    running: exit.is_none() && inst.child.is_some(),
                    started_at: Some(inst.started_at),
                    exit_code: exit,
                }
            })
            .collect()
    }

    pub async fn start(
        self: &Arc<Self>,
        id: &str,
        req: StartRequest,
    ) -> anyhow::Result<InstanceInfo> {
        let id = safe_id(id)?;
        let mut map = self.instances.lock().await;
        if let Some(inst) = map.get(id) {
            let exited = inst.exit_code.lock().expect("exit code lock").is_some();
            if !exited && inst.child.is_some() {
                // Already running: idempotent.
                return Ok(InstanceInfo {
                    id: id.to_string(),
                    port: inst.port,
                    pid: inst.pid,
                    running: true,
                    started_at: Some(inst.started_at),
                    exit_code: None,
                });
            }
        }
        // (Re)start.
        if let Some(mut old) = map.remove(id)
            && let Some(mut child) = old.child.take()
        {
            let _ = child.kill().await;
        }
        let dir = self.dir(id);
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let auth_path = dir.join("auth.json");
        // Only overwrite auth.json when the manager sends a different token
        // set; Codex may have refreshed the on-disk one since.
        let existing: Option<serde_json::Value> = std::fs::read_to_string(&auth_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let same_access = existing
            .as_ref()
            .and_then(|v| v.pointer("/tokens/access_token"))
            .is_some_and(|t| Some(t) == req.auth_json.pointer("/tokens/access_token"));
        if !same_access {
            let tmp = dir.join("auth.json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&req.auth_json)?)?;
            std::fs::rename(&tmp, &auth_path)?;
        }
        let log_path = dir.join("codexs.log");
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("opening {}", log_path.display()))?;
        let log_err = log.try_clone()?;

        let mut cmd = Command::new(&self.codexs_bin);
        cmd.arg("server")
            .arg("--host")
            .arg(&self.bind_host)
            .arg("--port")
            .arg(req.port.to_string())
            .arg("--codex-home")
            .arg(&dir)
            .current_dir(&dir)
            .env("HOME", &dir)
            .env_remove("CODEXS_CONFIG")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .kill_on_drop(true);
        if let Some(p) = req.proxy_url.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg("--proxy").arg(p);
        }
        let child = cmd
            .spawn()
            .with_context(|| format!("spawning {} for {id}", self.codexs_bin.display()))?;
        let pid = child.id();
        let exit_code = Arc::new(std::sync::Mutex::new(None));
        info!(instance = id, port = req.port, pid, "started codexs");

        // Reap in the background so `running` reflects reality; the Child
        // stays owned by the map so stop() can kill it.
        let exit_flag = Arc::clone(&exit_code);
        let watched_id = id.to_string();
        let inst = Instance {
            port: req.port,
            child: Some(child),
            pid,
            started_at: Utc::now(),
            exit_code,
        };
        map.insert(id.to_string(), inst);
        drop(map);
        let sup = Arc::clone(self);
        tokio::spawn(async move {
            sup.reaper(watched_id, exit_flag).await;
        });
        Ok(InstanceInfo {
            id: id.to_string(),
            port: req.port,
            pid,
            running: true,
            started_at: Some(Utc::now()),
            exit_code: None,
        })
    }

    /// Poll the child until it exits, then record the exit code.
    async fn reaper(&self, id: String, exit_flag: Arc<std::sync::Mutex<Option<i32>>>) {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let mut map = self.instances.lock().await;
            let Some(inst) = map.get_mut(&id) else { return };
            if !Arc::ptr_eq(&inst.exit_code, &exit_flag) {
                return; // restarted since; another reaper owns it
            }
            let Some(child) = inst.child.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code().unwrap_or(-1);
                    warn!(instance = %id, code, "codexs exited");
                    *exit_flag.lock().expect("exit code lock") = Some(code);
                    return;
                }
                Ok(None) => {}
                Err(e) => {
                    warn!(instance = %id, "try_wait failed: {e}");
                    *exit_flag.lock().expect("exit code lock") = Some(-1);
                    return;
                }
            }
        }
    }

    pub async fn stop(&self, id: &str) -> anyhow::Result<bool> {
        let id = safe_id(id)?;
        let mut map = self.instances.lock().await;
        let Some(mut inst) = map.remove(id) else {
            return Ok(false);
        };
        if let Some(mut child) = inst.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            info!(instance = id, "stopped codexs");
            return Ok(true);
        }
        Ok(false)
    }

    pub async fn logs(&self, id: &str, tail: usize) -> anyhow::Result<String> {
        let id = safe_id(id)?;
        let path = self.dir(id).join("codexs.log");
        let text = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("reading {}", path.display()))?;
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(tail);
        Ok(lines[start..].join("\n"))
    }

    pub async fn read_auth(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        let id = safe_id(id)?;
        let path = self.dir(id).join("auth.json");
        let raw = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("reading {}", path.display()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub async fn shutdown(&self) {
        let mut map = self.instances.lock().await;
        for (id, inst) in map.iter_mut() {
            if let Some(child) = inst.child.as_mut() {
                let _ = child.kill().await;
                info!(instance = %id, "killed on shutdown");
            }
        }
    }
}
