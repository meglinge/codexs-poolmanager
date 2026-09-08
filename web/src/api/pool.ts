import { apiRequest } from '@/api/client'

/**
 * poolmanager 后端(src/admin.rs)的类型化接口。页面只调这里的函数。
 */

export type AccountStatus = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'error'

export interface Account {
  id: string
  name: string
  runner_id: string
  port: number
  proxy_url: string | null
  max_concurrency: number
  rpm_limit: number | null
  enabled: boolean
  status: AccountStatus
  pid: number | null
  last_health: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  chatgpt_account_id?: string | null
}

export interface AccountInput {
  name: string
  runner_id: string
  port: number
  proxy_url: string | null
  auth_json: unknown | null
  max_concurrency: number
  rpm_limit: number | null
  enabled: boolean
}

export interface OverviewAccount {
  id: string
  name: string
  status: AccountStatus
  enabled: boolean
  runner_id: string
  port: number
  inflight: number
  max_concurrency: number
  last_error: string | null
  chatgpt_account_id: string | null
}

export interface Overview {
  instance: string
  version: string
  accounts_total: number
  accounts_running: number
  runners: number
  accounts: OverviewAccount[]
}

export interface ApiKey {
  id: string
  name: string
  key_prefix: string
  max_concurrency: number | null
  rpm_limit: number | null
  enabled: boolean
  created_at: string
  last_used_at: string | null
  /** 只在创建响应里出现一次。 */
  key?: string
}

export interface ApiKeyInput {
  name: string
  max_concurrency: number | null
  rpm_limit: number | null
  enabled: boolean
}

export interface Runner {
  id: string
  name: string
  base_url: string
  public_host: string
  last_seen: string | null
  created_at: string
  online?: boolean
  instances?: number | null
  runner_version?: string | null
  codexs_bin?: string | null
}

export interface RunnerInput {
  id: string
  name: string
  base_url: string
  public_host: string
  token: string
}

export interface UsageBucket {
  key: string | null
  name: string | null
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  avg_latency_ms: number
}

export interface UsageSummary {
  hours: number
  by_key: UsageBucket[]
  by_account: UsageBucket[]
}

export interface UsageRow {
  id: number
  ts: string
  api_key_id: string | null
  account_id: string | null
  path: string
  status: number
  latency_ms: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  error: string | null
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export const getOverview = () => apiRequest<Overview>('/overview')

export const listAccounts = () => apiRequest<Account[]>('/accounts')
export const createAccount = (input: AccountInput) => apiRequest<Account>('/accounts', { method: 'POST', ...json(input) })
export const updateAccount = (id: string, input: AccountInput) =>
  apiRequest<Account>(`/accounts/${id}`, { method: 'PUT', ...json(input) })
export const deleteAccount = (id: string) => apiRequest<{ ok: true }>(`/accounts/${id}`, { method: 'DELETE' })
export const accountAction = (id: string, action: 'start' | 'stop' | 'restart') =>
  apiRequest<{ ok: true }>(`/accounts/${id}/${action}`, { method: 'POST', body: '{}' })

/** 日志是纯文本,不走 apiRequest 的 JSON 解析。 */
export async function getAccountLogs(id: string, tail = 300): Promise<string> {
  const { getAuthToken } = await import('@/api/client')
  const res = await fetch(`/admin/api/accounts/${id}/logs?tail=${tail}`, {
    headers: { authorization: `Bearer ${getAuthToken()}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

export const listKeys = () => apiRequest<ApiKey[]>('/keys')
export const createKey = (input: ApiKeyInput) => apiRequest<ApiKey>('/keys', { method: 'POST', ...json(input) })
export const updateKey = (id: string, input: ApiKeyInput) => apiRequest<ApiKey>(`/keys/${id}`, { method: 'PUT', ...json(input) })
export const deleteKey = (id: string) => apiRequest<{ ok: true }>(`/keys/${id}`, { method: 'DELETE' })

export const listRunners = () => apiRequest<Runner[]>('/runners')
export const upsertRunner = (input: RunnerInput) => apiRequest<Runner>('/runners', { method: 'POST', ...json(input) })
export const deleteRunner = (id: string) => apiRequest<{ ok: true }>(`/runners/${id}`, { method: 'DELETE' })

export const getUsageSummary = (hours: number) => apiRequest<UsageSummary>(`/usage/summary?hours=${hours}`)
export const getRecentUsage = (limit = 100) => apiRequest<UsageRow[]>(`/usage/recent?limit=${limit}`)

export const STATUS_LABEL: Record<AccountStatus, string> = {
  running: '运行中',
  starting: '启动中',
  unhealthy: '异常',
  error: '失败',
  stopped: '已停止',
}
