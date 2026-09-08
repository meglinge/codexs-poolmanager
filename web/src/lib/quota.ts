import type { AccountQuota, OfficialDay, RateWindow, WindowRaw } from '@/api/usage'
import { windowLabel } from '@/lib/usage-format'

/**
 * 官方额度窗口(/wham/usage)的纯函数:把快照整理成可渲染的窗口列表,
 * 以及用「本周期官方已用成本 ÷ 实时已用百分比」估算周期总额度。
 */

export interface WindowView {
  label: string
  used: number | null
  seconds: number | null
  resetAt: string | null
}

export function fillTone(used: number | null): string {
  if (used == null) return 'bg-muted-foreground/40'
  if (used >= 100) return 'bg-destructive'
  if (used >= 80) return 'bg-amber-500'
  return 'bg-primary'
}

export function primaryWindows(q: AccountQuota | null | undefined): WindowView[] {
  if (!q) return []
  const out: WindowView[] = []
  if (q.primary_used_percent != null || q.primary_reset_at) {
    out.push({
      label: windowLabel(q.primary_window_seconds),
      used: q.primary_used_percent,
      seconds: q.primary_window_seconds,
      resetAt: q.primary_reset_at,
    })
  }
  if (q.secondary_used_percent != null || q.secondary_reset_at) {
    out.push({
      label: windowLabel(q.secondary_window_seconds),
      used: q.secondary_used_percent,
      seconds: q.secondary_window_seconds,
      resetAt: q.secondary_reset_at,
    })
  }
  return out
}

function rawWindow(w: WindowRaw | null | undefined, fetchedAt: number): WindowView | null {
  if (!w) return null
  const resetAt = w.reset_at
    ? new Date(w.reset_at * 1000).toISOString()
    : w.reset_after_seconds != null
      ? new Date(fetchedAt + w.reset_after_seconds * 1000).toISOString()
      : null
  return {
    label: windowLabel(w.limit_window_seconds),
    used: w.used_percent ?? null,
    seconds: w.limit_window_seconds ?? null,
    resetAt,
  }
}

export interface AdditionalLimit {
  name: string
  model: string | null
  windows: WindowView[]
}

export function additionalWindows(q: AccountQuota | null | undefined): AdditionalLimit[] {
  if (!q?.additional_limits?.length) return []
  const fetched = new Date(q.fetched_at).getTime() || Date.now()
  return q.additional_limits.map((l: RateWindow) => ({
    name: l.limit_name || l.metered_feature || '附加额度',
    model: l.normal_model_slug ?? null,
    windows: [rawWindow(l.rate_limit?.primary_window, fetched), rawWindow(l.rate_limit?.secondary_window, fetched)].filter(
      (w): w is WindowView => Boolean(w),
    ),
  }))
}

/** 长窗口(7d 槽)的标签:plus/pro 是周窗,free/team 实际是月窗。 */
export function longWindowLabel(q: AccountQuota | null | undefined): string {
  const s = q?.primary_window_seconds
  if (!s) return '7d'
  const days = Math.round(s / 86400)
  if (days >= 1) return `${days}d`
  return `${Math.round(s / 3600)}h`
}

/** 周期估算:本周期官方已用 ÷ 实时百分比。百分比只有整数精度,给 ±0.5% 区间。 */
export interface CycleEstimate {
  available: boolean
  reason?: 'no_window' | 'window_stale' | 'no_percent' | 'no_credits' | 'percent_too_low'
  startAt?: string
  resetAt?: string
  windowSeconds?: number
  usedPercent?: number
  percentUpdatedAt?: string
  usedCredits: number
  usedUsd: number
  days: number
  estimate?: { usd: number; low: number; high: number; reliable: boolean }
}

export function cycleEstimate(quota: AccountQuota | null | undefined, days: OfficialDay[], creditsPerUsd: number, now = Date.now()): CycleEstimate {
  const base: CycleEstimate = { available: false, usedCredits: 0, usedUsd: 0, days: 0 }
  if (!quota || !quota.primary_reset_at || !quota.primary_window_seconds) return { ...base, reason: 'no_window' }
  const resetMs = new Date(quota.primary_reset_at).getTime()
  const fetchedMs = new Date(quota.fetched_at).getTime()
  if (!Number.isFinite(resetMs)) return { ...base, reason: 'no_window' }
  const startMs = resetMs - quota.primary_window_seconds * 1000
  const startDay = new Date(startMs).toISOString().slice(0, 10)
  const inCycle = days.filter((d) => d.day >= startDay)
  const usedCredits = inCycle.reduce((s, d) => s + (d.credits || 0), 0)
  const usedUsd = usedCredits / creditsPerUsd
  const common = {
    startAt: new Date(startMs).toISOString(),
    resetAt: quota.primary_reset_at,
    windowSeconds: quota.primary_window_seconds,
    usedPercent: quota.primary_used_percent ?? undefined,
    percentUpdatedAt: quota.fetched_at,
    usedCredits,
    usedUsd,
    days: inCycle.length,
  }
  if (now - fetchedMs > 6 * 3600 * 1000) return { ...base, ...common, reason: 'window_stale' }
  const pct = quota.primary_used_percent
  if (pct == null) return { ...base, ...common, reason: 'no_percent' }
  if (usedCredits <= 0) return { ...base, ...common, reason: 'no_credits' }
  if (pct < 1) return { ...base, ...common, reason: 'percent_too_low' }
  const usd = usedUsd / (pct / 100)
  const low = usedUsd / ((pct + 0.5) / 100)
  const high = pct - 0.5 > 0 ? usedUsd / ((pct - 0.5) / 100) : usd * 2
  return { ...base, ...common, available: true, estimate: { usd, low, high, reliable: pct >= 10 } }
}

export const CYCLE_REASON_TEXT: Record<NonNullable<CycleEstimate['reason']>, string> = {
  no_window: '还没有探测到额度窗口',
  window_stale: '额度快照超过 6 小时没有更新',
  no_percent: '上游没有给出已用百分比',
  no_credits: '本周期还没有官方结算数据',
  percent_too_low: '已用不足 1%,无法可靠推算',
}
