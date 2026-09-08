import { apiRequest } from '@/api/client'
import type { AccountStatus } from '@/api/pool'

/**
 * 账号用量面板的接口(后端 src/admin_usage.rs)。
 * 两套口径:网关自己记的 usage_events(请求级,含估算成本),
 * 以及从 ChatGPT 官方后端同步的实时额度 / 按日结算(credits)。
 */

export type UsageRange = '24h' | '7d' | '30d' | '90d' | 'all'

export interface UsageTotals {
  requests: number
  success: number
  errors: number
  client_aborts: number
  cached_hits: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  cost_usd: number
  avg_latency_ms: number
  p50_latency_ms: number
  p95_latency_ms: number
  avg_ttft_ms: number | null
  p50_ttft_ms: number | null
  streams: number
  first_ts: string | null
  last_ts: string | null
}

export interface DayStat {
  day: string
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  cost_usd: number
  avg_latency_ms: number
}

export interface HourStat {
  hour: string
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

export interface ModelStat {
  model: string | null
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  cost_usd: number
  avg_latency_ms: number
  avg_ttft_ms: number | null
  last_ts: string | null
}

export interface KeyStat {
  api_key_id: string | null
  name: string | null
  key_prefix: string | null
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_usd: number
  avg_latency_ms: number
  last_ts: string | null
}

export interface StatusStat {
  status: number
  requests: number
  last_error: string | null
  last_ts: string | null
}

export interface EndpointStat {
  path: string
  stream: boolean
  requests: number
  errors: number
  avg_latency_ms: number
  avg_ttft_ms: number | null
}

export interface RateWindow {
  limit_name?: string
  metered_feature?: string
  normal_model_slug?: string | null
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: WindowRaw | null
    secondary_window?: WindowRaw | null
  } | null
}

export interface WindowRaw {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
}

export interface ResetCredit {
  id: string
  reset_type: string
  status: string
  granted_at?: string | null
  expires_at?: string | null
  consumable_until?: string | null
  redeemed_at?: string | null
  title?: string
  description?: string
}

export interface AccountQuota {
  account_id: string
  fetched_at: string
  ok: boolean
  error: string | null
  http_status: number | null
  plan_type: string | null
  email: string | null
  allowed: boolean | null
  limit_reached: boolean | null
  primary_used_percent: number | null
  primary_window_seconds: number | null
  primary_reset_at: string | null
  secondary_used_percent: number | null
  secondary_window_seconds: number | null
  secondary_reset_at: string | null
  additional_limits: RateWindow[]
  credits: {
    has_credits?: boolean
    unlimited?: boolean
    overage_limit_reached?: boolean
    balance?: string
    approx_local_messages?: number[]
    approx_cloud_messages?: number[]
  } | null
  reset_credits_available: number
  reset_credits_applicable: number
  reset_credits: ResetCredit[]
}

export interface AccountUsage {
  account: {
    id: string
    name: string
    status: AccountStatus
    enabled: boolean
    runner_id: string
    port: number
    proxy_url: string | null
    max_concurrency: number
    rpm_limit: number | null
    chatgpt_account_id: string | null
    created_at: string
  }
  range: string
  tz: string
  since: string | null
  totals: UsageTotals
  by_day: DayStat[]
  by_hour: HourStat[]
  by_model: ModelStat[]
  by_key: KeyStat[]
  by_status: StatusStat[]
  by_endpoint: EndpointStat[]
  quota: AccountQuota | null
}

export interface RequestRow {
  id: number
  ts: string
  api_key_id: string | null
  key_name: string | null
  path: string
  status: number
  latency_ms: number
  ttft_ms: number | null
  stream: boolean
  model: string | null
  service_tier: string | null
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  cost_usd: number
  error: string | null
}

export interface RequestPage {
  rows: RequestRow[]
  total: number
  limit: number
  offset: number
}

export interface DailyCounts {
  users?: number
  threads?: number
  turns?: number
  credits?: number
  uncached_text_input_tokens?: number
  cached_text_input_tokens?: number
  text_output_tokens?: number
  text_total_tokens?: number
}

export interface OfficialDay {
  account_id: string
  day: string
  users: number
  threads: number
  turns: number
  credits: number
  uncached_input: number | null
  cached_input: number | null
  output_tokens: number | null
  total_tokens: number | null
  clients: Array<{ client_id: string } & DailyCounts>
  models: Array<{ model: string } & DailyCounts>
  model_shares: Array<{ model: string; speed: string; percent: number }>
  surfaces: Record<string, number>
  settled: boolean
  synced_at: string
}

export interface OfficialUsage {
  days: OfficialDay[]
  sync: { account_id: string; last_sync_at: string | null; last_error: string | null; backfilled: boolean } | null
  credits_per_usd: number
  source: string
}

export interface HealthBucket {
  account_id: string
  bucket: string
  success: number
  failed: number
}

export interface AccountCounters {
  account_id: string
  requests_7d: number
  errors_7d: number
  requests_24h: number
  cost_7d: number
  cost_5h: number
  tokens_7d: number
  last_ts: string | null
}

export interface AccountsHealth {
  bucket_minutes: number
  buckets: number
  now: string
  health: Record<string, HealthBucket[]>
  counters: Record<string, AccountCounters>
  quota: Record<string, AccountQuota>
  official: Record<string, OfficialTotals>
  credits_per_usd: number
}

export interface OfficialTotals {
  account_id: string
  credits: number
  credits_7d: number
  days: number
  last_day: string | null
  synced_at: string | null
}

const tz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

export const getAccountUsage = (id: string, range: UsageRange) =>
  apiRequest<AccountUsage>(`/accounts/${id}/usage?range=${range}&tz=${encodeURIComponent(tz())}`)

export interface RequestQuery {
  range: UsageRange
  model?: string
  api_key_id?: string
  errors_only?: boolean
  limit?: number
  offset?: number
}

export const getAccountRequests = (id: string, q: RequestQuery) => {
  const p = new URLSearchParams({ range: q.range, tz: tz() })
  if (q.model) p.set('model', q.model)
  if (q.api_key_id) p.set('api_key_id', q.api_key_id)
  if (q.errors_only) p.set('errors_only', 'true')
  p.set('limit', String(q.limit ?? 50))
  p.set('offset', String(q.offset ?? 0))
  return apiRequest<RequestPage>(`/accounts/${id}/usage/requests?${p.toString()}`)
}

export const getAccountQuota = (id: string) => apiRequest<{ quota: AccountQuota | null }>(`/accounts/${id}/quota`)
export const refreshAccountQuota = (id: string) =>
  apiRequest<{ quota: AccountQuota }>(`/accounts/${id}/quota/refresh`, { method: 'POST', body: '{}' })

export const getAccountOfficial = (id: string, days = 90) =>
  apiRequest<OfficialUsage>(`/accounts/${id}/official?days=${days}`)
export const syncAccountOfficial = (id: string, days = 7) =>
  apiRequest<{ ok: true; days: number }>(`/accounts/${id}/official/sync?days=${days}`, { method: 'POST', body: '{}' })

export const consumeResetCredit = (id: string) =>
  apiRequest<{ ok: true; result: unknown; quota: AccountQuota | null }>(`/accounts/${id}/reset-credits/consume`, {
    method: 'POST',
    body: '{}',
  })

export const getAccountsHealth = (bucketMinutes = 10, buckets = 20) =>
  apiRequest<AccountsHealth>(`/accounts/health?bucket_minutes=${bucketMinutes}&buckets=${buckets}`)

export const getPricing = () => apiRequest<{ usd_per_1m_tokens: Record<string, Record<string, number>> }>('/pricing')
