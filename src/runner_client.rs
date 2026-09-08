//! Manager-side client for the runner control API.

use anyhow::Context;

use crate::db::Runner;
use crate::runner_api::InstanceInfo;
use crate::runner_api::RunnerHealth;
use crate::runner_api::StartRequest;

#[derive(Clone)]
pub struct RunnerClient {
    http: reqwest::Client,
}

impl RunnerClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    fn url(runner: &Runner, path: &str) -> String {
        format!(
            "{}/{}",
            runner.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    pub async fn health(&self, runner: &Runner) -> anyhow::Result<RunnerHealth> {
        Ok(self
            .http
            .get(Self::url(runner, "healthz"))
            .bearer_auth(&runner.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    pub async fn list(&self, runner: &Runner) -> anyhow::Result<Vec<InstanceInfo>> {
        Ok(self
            .http
            .get(Self::url(runner, "instances"))
            .bearer_auth(&runner.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    pub async fn start(
        &self,
        runner: &Runner,
        id: &str,
        req: &StartRequest,
    ) -> anyhow::Result<InstanceInfo> {
        let resp = self
            .http
            .post(Self::url(runner, &format!("instances/{id}/start")))
            .bearer_auth(&runner.token)
            .json(req)
            .send()
            .await
            .context("runner unreachable")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("runner returned {status}: {body}");
        }
        Ok(resp.json().await?)
    }

    pub async fn stop(&self, runner: &Runner, id: &str) -> anyhow::Result<bool> {
        let v: serde_json::Value = self
            .http
            .post(Self::url(runner, &format!("instances/{id}/stop")))
            .bearer_auth(&runner.token)
            .send()
            .await
            .context("runner unreachable")?
            .error_for_status()?
            .json()
            .await?;
        Ok(v.get("stopped").and_then(|b| b.as_bool()).unwrap_or(false))
    }

    pub async fn logs(&self, runner: &Runner, id: &str, tail: usize) -> anyhow::Result<String> {
        Ok(self
            .http
            .get(Self::url(
                runner,
                &format!("instances/{id}/logs?tail={tail}"),
            ))
            .bearer_auth(&runner.token)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?)
    }

    pub async fn auth(&self, runner: &Runner, id: &str) -> anyhow::Result<serde_json::Value> {
        Ok(self
            .http
            .get(Self::url(runner, &format!("instances/{id}/auth")))
            .bearer_auth(&runner.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
}
