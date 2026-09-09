//! Redis-backed shared state: in-flight counters, rate limits, session
//! stickiness, admin sessions and the leader lock for background jobs.

use redis::AsyncCommands;
use redis::aio::ConnectionManager;
use uuid::Uuid;

#[derive(Clone)]
pub struct Cache {
    con: ConnectionManager,
}

impl Cache {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url)?;
        let con = client.get_connection_manager().await?;
        Ok(Self { con })
    }

    pub async fn ping(&self) -> anyhow::Result<()> {
        let mut c = self.con.clone();
        let _: String = redis::cmd("PING").query_async(&mut c).await?;
        Ok(())
    }

    // ---- in-flight counters -------------------------------------------------

    fn inflight_key(scope: &str, id: Uuid) -> String {
        format!("pm:inflight:{scope}:{id}")
    }

    /// Increment an in-flight counter; returns the new value. The key expires
    /// on its own so a crashed replica cannot pin a slot forever.
    pub async fn inflight_acquire(
        &self,
        scope: &str,
        id: Uuid,
        ttl_secs: u64,
    ) -> anyhow::Result<i64> {
        let mut c = self.con.clone();
        let key = Self::inflight_key(scope, id);
        let (n, _): (i64, bool) = redis::pipe()
            .incr(&key, 1)
            .expire(&key, ttl_secs as i64)
            .query_async(&mut c)
            .await?;
        Ok(n)
    }

    pub async fn inflight_release(&self, scope: &str, id: Uuid) -> anyhow::Result<()> {
        let mut c = self.con.clone();
        let key = Self::inflight_key(scope, id);
        let n: i64 = c.decr(&key, 1).await?;
        if n <= 0 {
            let _: usize = c.del(&key).await?;
        }
        Ok(())
    }

    pub async fn inflight_get(&self, scope: &str, id: Uuid) -> anyhow::Result<i64> {
        let mut c = self.con.clone();
        let v: Option<i64> = c.get(Self::inflight_key(scope, id)).await?;
        Ok(v.unwrap_or(0).max(0))
    }

    // ---- fixed-window per-minute rate limit ---------------------------------

    /// Returns the request count within the current minute after counting this one.
    pub async fn rate_hit(&self, scope: &str, id: Uuid) -> anyhow::Result<i64> {
        let mut c = self.con.clone();
        let minute = chrono::Utc::now().timestamp() / 60;
        let key = format!("pm:rl:{scope}:{id}:{minute}");
        let (n, _): (i64, bool) = redis::pipe()
            .incr(&key, 1)
            .expire(&key, 120)
            .query_async(&mut c)
            .await?;
        Ok(n)
    }

    // ---- session stickiness --------------------------------------------------

    pub async fn sticky_set(
        &self,
        kind: &str,
        token: &str,
        account: Uuid,
        ttl_secs: u64,
    ) -> anyhow::Result<()> {
        let mut c = self.con.clone();
        let _: () = c
            .set_ex(
                format!("pm:sticky:{kind}:{token}"),
                account.to_string(),
                ttl_secs,
            )
            .await?;
        Ok(())
    }

    pub async fn sticky_get(&self, kind: &str, token: &str) -> anyhow::Result<Option<Uuid>> {
        let mut c = self.con.clone();
        let v: Option<String> = c.get(format!("pm:sticky:{kind}:{token}")).await?;
        Ok(v.and_then(|s| Uuid::parse_str(&s).ok()))
    }

    // ---- admin sessions ------------------------------------------------------

    pub async fn session_create(&self, ttl_secs: u64) -> anyhow::Result<String> {
        let sid = crate::util::random_token(32);
        let mut c = self.con.clone();
        let _: () = c.set_ex(format!("pm:session:{sid}"), "1", ttl_secs).await?;
        Ok(sid)
    }

    pub async fn session_valid(&self, sid: &str, ttl_secs: u64) -> anyhow::Result<bool> {
        let mut c = self.con.clone();
        let key = format!("pm:session:{sid}");
        let exists: bool = c.exists(&key).await?;
        if exists {
            let _: bool = c.expire(&key, ttl_secs as i64).await?;
        }
        Ok(exists)
    }

    pub async fn session_delete(&self, sid: &str) -> anyhow::Result<()> {
        let mut c = self.con.clone();
        let _: usize = c.del(format!("pm:session:{sid}")).await?;
        Ok(())
    }

    // ---- leader lock ---------------------------------------------------------

    /// Try to (re)acquire the background-job leadership for `ttl_ms`.
    pub async fn leader_acquire(&self, holder: &str, ttl_ms: u64) -> anyhow::Result<bool> {
        let mut c = self.con.clone();
        // SET NX PX: only one replica wins; the winner refreshes via the
        // compare-and-extend script below.
        let set: Option<String> = redis::cmd("SET")
            .arg("pm:leader")
            .arg(holder)
            .arg("NX")
            .arg("PX")
            .arg(ttl_ms)
            .query_async(&mut c)
            .await?;
        if set.is_some() {
            return Ok(true);
        }
        let script = redis::Script::new(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
        );
        let extended: i64 = script
            .key("pm:leader")
            .arg(holder)
            .arg(ttl_ms)
            .invoke_async(&mut c)
            .await?;
        Ok(extended == 1)
    }

    // ---- A/B slot ------------------------------------------------------------

    /// Slot (`a` / `b`) the deployment controller marked active, if any.
    /// Absent key = no slot distinction (both replicas may lead).
    pub async fn active_slot(&self) -> anyhow::Result<Option<String>> {
        let mut c = self.con.clone();
        let v: Option<String> = c.get("pm:deploy:active").await?;
        Ok(v.map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| s == "a" || s == "b"))
    }

    /// Give leadership back immediately (only if we still hold it) so the
    /// new active slot can take over without waiting for the TTL.
    pub async fn leader_release(&self, holder: &str) -> anyhow::Result<bool> {
        let mut c = self.con.clone();
        let script = redis::Script::new(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        );
        let n: i64 = script
            .key("pm:leader")
            .arg(holder)
            .invoke_async(&mut c)
            .await?;
        Ok(n == 1)
    }
}
