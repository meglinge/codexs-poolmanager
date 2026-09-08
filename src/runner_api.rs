//! Wire types shared by the runner control API and the manager-side client.

use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRequest {
    pub port: u16,
    pub proxy_url: Option<String>,
    /// Full Codex auth.json content.
    pub auth_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub id: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub running: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerHealth {
    pub ok: bool,
    pub version: String,
    pub codexs_bin: String,
    pub instances: usize,
}
