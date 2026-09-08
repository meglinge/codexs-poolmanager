//! Model price table (USD per 1M tokens). `pricing.json` is embedded at build
//! time (same format as codex2api's `pricing.json`) and can be extended or
//! overridden at runtime with `PM_PRICING_FILE`.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ModelPrice {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub cached_input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(default)]
    pub input_priority: f64,
    #[serde(default)]
    pub cached_input_priority: f64,
    #[serde(default)]
    pub output_priority: f64,
    #[serde(default)]
    pub input_long: f64,
    #[serde(default)]
    pub cached_input_long: f64,
    #[serde(default)]
    pub output_long: f64,
}

/// Inputs at or above this many tokens use the `*_long` prices when present.
const LONG_CONTEXT_THRESHOLD: i64 = 272_000;

static TABLE: OnceLock<HashMap<String, ModelPrice>> = OnceLock::new();

pub fn table() -> &'static HashMap<String, ModelPrice> {
    TABLE.get_or_init(|| {
        let mut t: HashMap<String, ModelPrice> =
            serde_json::from_str(include_str!("pricing.json")).unwrap_or_default();
        if let Ok(path) = std::env::var("PM_PRICING_FILE")
            && let Ok(text) = std::fs::read_to_string(&path)
        {
            match serde_json::from_str::<HashMap<String, ModelPrice>>(&text) {
                Ok(extra) => t.extend(extra),
                Err(e) => tracing::warn!("PM_PRICING_FILE {path}: {e}"),
            }
        }
        t.into_iter()
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v))
            .collect()
    })
}

/// Price entry for `model`: exact match first, then the longest table key the
/// model name starts with (`gpt-5.5-2026-01-01` → `gpt-5.5`).
pub fn lookup(model: &str) -> Option<(&'static str, &'static ModelPrice)> {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return None;
    }
    let t = table();
    if let Some((k, v)) = t.get_key_value(m.as_str()) {
        return Some((k.as_str(), v));
    }
    t.iter()
        .filter(|(k, _)| m.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len())
        .map(|(k, v)| (k.as_str(), v))
}

/// Estimated cost in USD for one request. `input` includes the cached part.
pub fn cost_usd(
    model: &str,
    service_tier: Option<&str>,
    input: i64,
    output: i64,
    cached: i64,
) -> f64 {
    let Some((_, p)) = lookup(model) else {
        return 0.0;
    };
    let cached = cached.clamp(0, input.max(0));
    let uncached = (input - cached).max(0);
    let long = input >= LONG_CONTEXT_THRESHOLD && p.input_long > 0.0;
    let priority = matches!(
        service_tier
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("priority") | Some("fast")
    ) && p.input_priority > 0.0;

    let (mut inp, mut cin, mut out) = (p.input, p.cached_input, p.output);
    if long {
        inp = p.input_long;
        out = if p.output_long > 0.0 {
            p.output_long
        } else {
            out
        };
        if p.cached_input_long > 0.0 {
            cin = p.cached_input_long;
        }
    }
    if priority {
        inp = p.input_priority;
        if p.output_priority > 0.0 {
            out = p.output_priority;
        }
        if p.cached_input_priority > 0.0 {
            cin = p.cached_input_priority;
        }
    }
    // Models without a cached price bill cached tokens at the input price.
    let cached_cost = if cin > 0.0 { cin } else { inp };
    (uncached as f64 * inp + cached as f64 * cached_cost + output as f64 * out) / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_and_prefix_lookup() {
        assert!(lookup("gpt-5.5").is_some());
        assert_eq!(lookup("gpt-5.5-2026-06-01").unwrap().0, "gpt-5.5");
        assert_eq!(lookup("GPT-5.4-mini").unwrap().0, "gpt-5.4-mini");
        assert!(lookup("does-not-exist").is_none());
    }

    #[test]
    fn cost_formula() {
        // gpt-5.5: input 5, cached 0.5, output 30 per 1M.
        let c = cost_usd("gpt-5.5", None, 100_000, 10_000, 40_000);
        let expected = 60_000.0 * 5.0 / 1e6 + 40_000.0 * 0.5 / 1e6 + 10_000.0 * 30.0 / 1e6;
        // Above the long-context threshold the *_long prices apply.
        assert!(cost_usd("gpt-5.5", None, 300_000, 0, 0) > 300_000.0 * 5.0 / 1e6);
        assert!((c - expected).abs() < 1e-9, "{c} vs {expected}");
        assert!(
            cost_usd("gpt-5.5", Some("priority"), 1000, 0, 0)
                > cost_usd("gpt-5.5", None, 1000, 0, 0)
        );
        assert_eq!(cost_usd("unknown", None, 10, 10, 0), 0.0);
    }
}
