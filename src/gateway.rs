//! Downstream-facing gateway: authenticates API keys, enforces limits, picks
//! a codexs instance and streams the response back.

use std::pin::Pin;
use std::sync::Arc;
use std::task::Context;
use std::task::Poll;
use std::time::Instant;

use axum::Router;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::HeaderValue;
use axum::http::Method;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::any;
use futures::Stream;

use tracing::debug;
use tracing::warn;
use uuid::Uuid;

use crate::db;
use crate::db::Account;
use crate::db::ApiKey;
use crate::state::AppState;
use crate::util::sha256_hex;

const MAX_BODY: usize = 32 * 1024 * 1024;
const HEAD_KEEP: usize = 16 * 1024;
const TAIL_KEEP: usize = 64 * 1024;
/// Safety net for in-flight counters if a replica dies mid-request.
const INFLIGHT_TTL_SECS: u64 = 3600;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/{*rest}", any(proxy))
        .with_state(state)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    let body = serde_json::json!({
        "error": { "message": msg.into(), "type": "gateway_error", "code": status.as_u16() }
    });
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

#[allow(clippy::result_large_err)]
async fn authenticate(st: &AppState, headers: &HeaderMap) -> Result<ApiKey, Response> {
    let Some(key) = bearer(headers) else {
        return Err(err(StatusCode::UNAUTHORIZED, "missing API key"));
    };
    match db::find_api_key_by_hash(&st.db, &sha256_hex(key)).await {
        Ok(Some(k)) if k.enabled => Ok(k),
        Ok(_) => Err(err(StatusCode::UNAUTHORIZED, "invalid API key")),
        Err(e) => {
            warn!("api key lookup failed: {e}");
            Err(err(StatusCode::SERVICE_UNAVAILABLE, "database unavailable"))
        }
    }
}

/// Which account a request must go to, if the conversation is already pinned.
async fn sticky_account(
    st: &AppState,
    headers: &HeaderMap,
    body: &serde_json::Value,
) -> Option<Uuid> {
    let mut lookups: Vec<(&str, String)> = Vec::new();
    if let Some(s) = headers.get("x-asxs-session").and_then(|v| v.to_str().ok()) {
        lookups.push(("sess", s.to_string()));
    }
    if let Some(s) = body.pointer("/asxs/session_id").and_then(|v| v.as_str()) {
        lookups.push(("sess", s.to_string()));
    }
    if let Some(p) = body.get("previous_response_id").and_then(|v| v.as_str()) {
        lookups.push(("resp", p.to_string()));
    }
    for (kind, token) in lookups {
        match st.cache.sticky_get(kind, &token).await {
            Ok(Some(id)) => return Some(id),
            Ok(None) => {}
            Err(e) => warn!("sticky lookup failed: {e}"),
        }
    }
    None
}

struct Lease {
    account: Account,
    url: String,
}

/// Pick a healthy account with free capacity and take an in-flight slot on it.
#[allow(clippy::result_large_err)]
async fn acquire_account(st: &AppState, pinned: Option<Uuid>) -> Result<Lease, Response> {
    let snap = st.snapshot();
    let eligible = |a: &Account| a.enabled && a.status == "running";

    if let Some(id) = pinned {
        match snap.account(id) {
            Some(a) if eligible(a) => {
                // Pinned conversations bypass the concurrency cap: the turn
                // continues on the thread that owns it.
                let _ = st
                    .cache
                    .inflight_acquire("acct", a.id, INFLIGHT_TTL_SECS)
                    .await;
                let url = snap
                    .instance_url(a)
                    .ok_or_else(|| err(StatusCode::BAD_GATEWAY, "runner missing"))?;
                return Ok(Lease {
                    account: a.clone(),
                    url,
                });
            }
            _ => {
                return Err(err(
                    StatusCode::CONFLICT,
                    "the account holding this conversation is no longer available",
                ));
            }
        }
    }

    // Least-loaded first (in-flight / max_concurrency).
    let mut candidates: Vec<(f64, &Account)> = Vec::new();
    for a in snap.accounts.iter().filter(|a| eligible(a)) {
        let inflight = st.cache.inflight_get("acct", a.id).await.unwrap_or(0);
        candidates.push((inflight as f64 / a.max_concurrency.max(1) as f64, a));
    }
    candidates.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    if candidates.is_empty() {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "no running Codex account",
        ));
    }
    for (_, a) in candidates {
        if let Some(rpm) = a.rpm_limit
            && st.cache.rate_hit("acct", a.id).await.unwrap_or(0) > rpm as i64
        {
            continue;
        }
        match st
            .cache
            .inflight_acquire("acct", a.id, INFLIGHT_TTL_SECS)
            .await
        {
            Ok(n) if n <= a.max_concurrency as i64 => {
                let url = snap
                    .instance_url(a)
                    .ok_or_else(|| err(StatusCode::BAD_GATEWAY, "runner missing"))?;
                return Ok(Lease {
                    account: a.clone(),
                    url,
                });
            }
            Ok(_) => {
                let _ = st.cache.inflight_release("acct", a.id).await;
            }
            Err(e) => {
                warn!("redis inflight failed: {e}");
                return Err(err(StatusCode::SERVICE_UNAVAILABLE, "redis unavailable"));
            }
        }
    }
    let mut r = err(
        StatusCode::TOO_MANY_REQUESTS,
        "all Codex accounts are at capacity",
    );
    r.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
    Err(r)
}

async fn proxy(State(st): State<Arc<AppState>>, req: axum::extract::Request) -> Response {
    let started = Instant::now();
    let (parts, body) = req.into_parts();
    let path_q = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| parts.uri.path().to_string());
    let path = parts.uri.path().to_string();

    let key = match authenticate(&st, &parts.headers).await {
        Ok(k) => k,
        Err(r) => return r,
    };

    // Per-key limits.
    if let Some(rpm) = key.rpm_limit
        && st.cache.rate_hit("key", key.id).await.unwrap_or(0) > rpm as i64
    {
        let mut r = err(StatusCode::TOO_MANY_REQUESTS, "API key rate limit exceeded");
        r.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
        return r;
    }
    let key_slot = match key.max_concurrency {
        Some(max) => match st
            .cache
            .inflight_acquire("key", key.id, INFLIGHT_TTL_SECS)
            .await
        {
            Ok(n) if n <= max as i64 => true,
            Ok(_) => {
                let _ = st.cache.inflight_release("key", key.id).await;
                return err(
                    StatusCode::TOO_MANY_REQUESTS,
                    "API key concurrency limit exceeded",
                );
            }
            Err(e) => {
                warn!("redis inflight failed: {e}");
                return err(StatusCode::SERVICE_UNAVAILABLE, "redis unavailable");
            }
        },
        None => false,
    };
    let release_key = {
        let st = Arc::clone(&st);
        let id = key.id;
        move || {
            if key_slot {
                tokio::spawn(async move {
                    let _ = st.cache.inflight_release("key", id).await;
                });
            }
        }
    };

    let body_bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => {
            release_key();
            return err(StatusCode::PAYLOAD_TOO_LARGE, "request body too large");
        }
    };
    let json: serde_json::Value = if parts.method == Method::POST && !body_bytes.is_empty() {
        serde_json::from_slice(&body_bytes).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };

    // GET /v1/models and friends: no capacity accounting, any running account.
    let accounting = parts.method == Method::POST;
    let lease = if accounting {
        let pinned = sticky_account(&st, &parts.headers, &json).await;
        match acquire_account(&st, pinned).await {
            Ok(l) => l,
            Err(r) => {
                release_key();
                return r;
            }
        }
    } else {
        let snap = st.snapshot();
        match snap
            .accounts
            .iter()
            .find(|a| a.enabled && a.status == "running")
        {
            Some(a) => match snap.instance_url(a) {
                Some(url) => Lease {
                    account: a.clone(),
                    url,
                },
                None => {
                    release_key();
                    return err(StatusCode::BAD_GATEWAY, "runner missing");
                }
            },
            None => {
                release_key();
                return err(StatusCode::SERVICE_UNAVAILABLE, "no running Codex account");
            }
        }
    };
    debug!(account = %lease.account.name, path = %path, "forwarding");

    // Forward.
    let mut upstream = st
        .http
        .request(parts.method.clone(), format!("{}{}", lease.url, path_q))
        .body(body_bytes);
    for (name, value) in &parts.headers {
        let n = name.as_str();
        if n == "content-type" || n == "accept" || n.starts_with("x-asxs-") {
            upstream = upstream.header(name, value);
        }
    }
    let resp = match upstream.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!(account = %lease.account.name, "upstream request failed: {e}");
            release_key();
            if accounting {
                let _ = st.cache.inflight_release("acct", lease.account.id).await;
            }
            record_usage(
                &st,
                &key,
                Some(lease.account.id),
                &path,
                502,
                started,
                None,
                Some(e.to_string()),
            );
            return err(
                StatusCode::BAD_GATEWAY,
                format!("codexs instance unreachable: {e}"),
            );
        }
    };

    let status = resp.status();
    let mut out_headers = HeaderMap::new();
    for (name, value) in resp.headers() {
        let n = name.as_str();
        if n == "content-type" || n == "cache-control" || n.starts_with("x-asxs-") {
            out_headers.insert(name.clone(), value.clone());
        }
    }
    // A session id in the response header pins future requests carrying it.
    if let Some(s) = resp
        .headers()
        .get("x-asxs-session")
        .and_then(|v| v.to_str().ok())
    {
        let _ = st
            .cache
            .sticky_set("sess", s, lease.account.id, st.cfg.sticky_ttl_secs)
            .await;
    }

    let observer = Observer {
        st: Arc::clone(&st),
        key: key.clone(),
        account_id: lease.account.id,
        path: path.clone(),
        status: status.as_u16() as i32,
        started,
        accounting,
        release_key: Some(Box::new(release_key)),
        head: Vec::with_capacity(HEAD_KEEP),
        tail: Vec::with_capacity(TAIL_KEEP),
        inner: Box::pin(resp.bytes_stream()),
        done: false,
    };
    let mut response = Response::new(Body::from_stream(observer));
    *response.status_mut() =
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    *response.headers_mut() = out_headers;
    response
}

/// Wraps the upstream byte stream: keeps the head and tail of the body to
/// extract the response id (stickiness) and token usage, and settles the
/// in-flight counters / usage record when the stream ends or is dropped.
struct Observer {
    st: Arc<AppState>,
    key: ApiKey,
    account_id: Uuid,
    path: String,
    status: i32,
    started: Instant,
    accounting: bool,
    release_key: Option<Box<dyn FnOnce() + Send>>,
    head: Vec<u8>,
    tail: Vec<u8>,
    inner: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    done: bool,
}

impl Stream for Observer {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                if self.head.len() < HEAD_KEEP {
                    let take = (HEAD_KEEP - self.head.len()).min(chunk.len());
                    self.head.extend_from_slice(&chunk[..take]);
                }
                self.tail.extend_from_slice(&chunk);
                if self.tail.len() > TAIL_KEEP {
                    let cut = self.tail.len() - TAIL_KEEP;
                    self.tail.drain(..cut);
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(std::io::Error::other(e)))),
            Poll::Ready(None) => {
                self.finish(None);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Observer {
    fn finish(&mut self, error: Option<String>) {
        if self.done {
            return;
        }
        self.done = true;
        if let Some(f) = self.release_key.take() {
            f();
        }
        let st = Arc::clone(&self.st);
        let account_id = self.account_id;
        let accounting = self.accounting;
        let response_id = extract_response_id(&self.head);
        let usage = extract_usage(&self.tail);
        let ttl = st.cfg.sticky_ttl_secs;
        let cleanup_st = Arc::clone(&st);
        tokio::spawn(async move {
            if accounting {
                let _ = cleanup_st.cache.inflight_release("acct", account_id).await;
            }
            if let Some(id) = response_id {
                let _ = cleanup_st
                    .cache
                    .sticky_set("resp", &id, account_id, ttl)
                    .await;
            }
        });
        record_usage(
            &st,
            &self.key,
            Some(account_id),
            &self.path,
            self.status,
            self.started,
            usage,
            error,
        );
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        // Client went away mid-stream.
        self.finish(if self.done {
            None
        } else {
            Some("client disconnected".to_string())
        });
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Usage {
    pub input: i64,
    pub output: i64,
    pub cached: i64,
}

#[allow(clippy::too_many_arguments)]
fn record_usage(
    st: &Arc<AppState>,
    key: &ApiKey,
    account_id: Option<Uuid>,
    path: &str,
    status: i32,
    started: Instant,
    usage: Option<Usage>,
    error: Option<String>,
) {
    let st = Arc::clone(st);
    let key_id = key.id;
    let event = db::UsageEvent {
        api_key_id: Some(key_id),
        account_id,
        path: path.to_string(),
        status,
        latency_ms: started.elapsed().as_millis().min(i32::MAX as u128) as i32,
        input_tokens: usage.map(|u| u.input).unwrap_or(0),
        output_tokens: usage.map(|u| u.output).unwrap_or(0),
        cached_tokens: usage.map(|u| u.cached).unwrap_or(0),
        error,
    };
    tokio::spawn(async move {
        if let Err(e) = db::insert_usage(&st.db, &event).await {
            warn!("usage insert failed: {e}");
        }
        let _ = db::touch_api_key(&st.db, key_id).await;
    });
}

/// First `"id":"..."` in the body head: `resp_…` (Responses) or `chatcmpl-…` (Chat).
fn extract_response_id(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    let mut search = 0;
    while let Some(pos) = text[search..].find("\"id\"") {
        let after = &text[search + pos + 4..];
        let after = after.trim_start().strip_prefix(':')?.trim_start();
        if let Some(rest) = after.strip_prefix('"') {
            let end = rest.find('"')?;
            let id = &rest[..end];
            if id.starts_with("resp_") || id.starts_with("chatcmpl") {
                return Some(id.to_string());
            }
        }
        search += pos + 4;
    }
    None
}

/// Last `"usage":{...}` object in the body tail (works for SSE and JSON).
fn extract_usage(tail: &[u8]) -> Option<Usage> {
    let text = String::from_utf8_lossy(tail);
    let pos = text.rfind("\"usage\"")?;
    let rest = &text[pos + 7..];
    let start = rest.find('{')?;
    let mut depth = 0i32;
    let mut end = None;
    for (i, ch) in rest[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + i + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let obj: serde_json::Value = serde_json::from_str(&rest[start..end?]).ok()?;
    let g = |k: &str| obj.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let cached = obj
        .pointer("/input_tokens_details/cached_tokens")
        .or_else(|| obj.pointer("/prompt_tokens_details/cached_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Some(Usage {
        input: g("input_tokens").max(g("prompt_tokens")),
        output: g("output_tokens").max(g("completion_tokens")),
        cached,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_id_from_sse() {
        let head = br#"event: response.created
data: {"type":"response.created","response":{"id":"resp_abc123","object":"response"}}
"#;
        assert_eq!(extract_response_id(head).as_deref(), Some("resp_abc123"));
    }

    #[test]
    fn response_id_from_chat_json() {
        let head = br#"{"id":"chatcmpl-xyz","object":"chat.completion","choices":[]}"#;
        assert_eq!(extract_response_id(head).as_deref(), Some("chatcmpl-xyz"));
    }

    #[test]
    fn usage_from_responses_completed() {
        let tail = br#"data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":100},"output_tokens":30,"total_tokens":150}}}

data: [DONE]
"#;
        let u = extract_usage(tail).unwrap();
        assert_eq!((u.input, u.output, u.cached), (120, 30, 100));
    }

    #[test]
    fn usage_from_chat_chunk() {
        let tail = br#"data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}"#;
        let u = extract_usage(tail).unwrap();
        assert_eq!((u.input, u.output, u.cached), (10, 5, 4));
    }
}
