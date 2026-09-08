import { useCallback, useState } from 'react'

import type { UsageRange } from '@/api/usage'
import { readFullNumbers, writeFullNumbers } from '@/lib/usage-format'

/** 面板各页签共用的常量、格式化和 hook(不含组件,组件在 shared.tsx)。 */


export const COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  '#2563eb',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#ea580c',
  '#4f46e5',
  'hsl(var(--chart-4))',
]

export const RANGE_OPTIONS: Array<{ key: UsageRange; label: string; days: number }> = [
  { key: '24h', label: '24 小时', days: 1 },
  { key: '7d', label: '7 天', days: 7 },
  { key: '30d', label: '30 天', days: 30 },
  { key: '90d', label: '90 天', days: 90 },
  { key: 'all', label: '全部', days: 0 },
]

export const rangeDays = (r: UsageRange) => RANGE_OPTIONS.find((o) => o.key === r)?.days ?? 30

export type MetricKey = 'requests' | 'tokens' | 'cost'
export const METRIC_OPTIONS: Array<{ key: MetricKey; label: string }> = [
  { key: 'requests', label: '请求' },
  { key: 'tokens', label: 'Token' },
  { key: 'cost', label: '成本' },
]

export type Tone = 'neutral' | 'success' | 'warning' | 'danger'

export const TONE = {
  neutral: { box: 'bg-background border-border/80', icon: 'bg-muted text-muted-foreground', value: 'text-foreground' },
  success: { box: 'bg-primary/5 border-primary/25', icon: 'bg-primary/10 text-primary', value: 'text-primary' },
  warning: {
    box: 'bg-amber-500/5 border-amber-500/25',
    icon: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    value: 'text-amber-600 dark:text-amber-400',
  },
  danger: { box: 'bg-destructive/5 border-destructive/25', icon: 'bg-destructive/10 text-destructive', value: 'text-destructive' },
} satisfies Record<Tone, { box: string; icon: string; value: string }>

/** 本地日期键(浏览器时区),与后端按 tz 分桶的 by_day 对齐。 */
export function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 网关成本:小额保留 4 位(单次请求可能只有几厘),不带 $。 */
export function formatCost(v: number | null | undefined): string {
  const n = Number(v || 0)
  return n >= 1 ? n.toFixed(2) : n.toFixed(4)
}

/** 官方结算:统一 2 位,小于 1 分显示 <$0.01,与官方账单口径对齐。 */
export function formatUSD(v: number | null | undefined): string {
  const n = Number(v || 0)
  if (!Number.isFinite(n) || n === 0) return '$0'
  if (Math.abs(n) < 0.01) return '<$0.01'
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatCredits(v: number): string {
  if (!Number.isFinite(v)) return '0'
  return (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export function formatShare(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%'
  const p = v * 100
  if (p < 0.1) return '<0.1%'
  return `${p.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: p < 10 ? 1 : 0 })}%`
}

export function formatInt(v: number | null | undefined): string {
  return Math.round(Number(v || 0)).toLocaleString('zh-CN')
}

export function formatDurationMs(v: number | null | undefined): string {
  const n = Number(v || 0)
  if (n <= 0) return '0ms'
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`
  return `${Math.round(n)}ms`
}

export const formatDurationOrDash = (v: number | null | undefined) => (Number(v || 0) > 0 ? formatDurationMs(v) : '-')

export function formatPercent2(v: number): string {
  const n = Number(v || 0)
  return `${n.toFixed(n >= 10 ? 1 : 2)}%`
}

export function useFullNumbers(): [boolean, (v: boolean) => void] {
  const [full, setFull] = useState(() => readFullNumbers())
  const set = useCallback((v: boolean) => {
    writeFullNumbers(v)
    setFull(v)
  }, [])
  return [full, set]
}

export function metricValue(m: { requests: number; input_tokens: number; output_tokens: number; cost_usd: number }, metric: MetricKey): number {
  switch (metric) {
    case 'tokens':
      return m.input_tokens + m.output_tokens
    case 'cost':
      return m.cost_usd
    default:
      return m.requests
  }
}
