import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, BarChart3, Coins, Gauge, Package, RefreshCw, Zap } from 'lucide-react'

import { getAccountOfficial, syncAccountOfficial, type AccountQuota, type OfficialDay, type OfficialUsage, type UsageRange } from '@/api/usage'
import { Button } from '@/components/ui/button'
import { CYCLE_REASON_TEXT, cycleEstimate } from '@/lib/quota'
import { clientLabel, formatCompact, formatDateTimeFull } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

import { Banner, CompactMetric, Section } from './shared'
import { formatCredits, formatInt, formatShare, formatUSD } from './lib'

/**
 * 官方结算页:数据来自 ChatGPT 后端的按日工作区用量(credits、token、按客户端 / 模型拆分),
 * 不是网关自己的记录。能看出账号有多少消耗来自本网关、多少来自官方客户端。
 */

const rangeToDays = (r: UsageRange) => (r === '24h' ? 2 : r === '7d' ? 7 : r === '30d' ? 30 : r === '90d' ? 90 : 365)

interface Split {
  label: string
  credits: number
  usd: number
  turns: number
  tokens: number
  share: number
}

function aggregateClients(days: OfficialDay[], perUsd: number): Split[] {
  const map = new Map<string, Split>()
  for (const d of days) {
    for (const c of d.clients ?? []) {
      const label = clientLabel((c.client_id ?? '').trim() || '-')
      const cur = map.get(label) ?? { label, credits: 0, usd: 0, turns: 0, tokens: 0, share: 0 }
      cur.credits += c.credits ?? 0
      cur.usd += (c.credits ?? 0) / perUsd
      cur.turns += c.turns ?? 0
      cur.tokens += c.text_total_tokens ?? 0
      map.set(label, cur)
    }
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || b.turns - a.turns)
}

interface ModelSplit {
  rows: Split[]
  hasBreakdown: boolean
  hasCost: boolean
  breakdownDays: number
  totalDays: number
}

/** 模型成本按 (model, speed) 的当天份额分摊;轮次来自 counts.models,挂到 standard 行。 */
function aggregateModels(days: OfficialDay[], perUsd: number): ModelSplit {
  const withBreakdown = days.filter((d) => Array.isArray(d.model_shares) && d.model_shares.length > 0)
  if (!withBreakdown.length) {
    const map = new Map<string, Split>()
    for (const d of days) {
      for (const m of d.models ?? []) {
        const label = (m.model ?? '').trim() || '-'
        const cur = map.get(label) ?? { label, credits: 0, usd: 0, turns: 0, tokens: 0, share: 0 }
        cur.turns += m.turns ?? 0
        map.set(label, cur)
      }
    }
    return { rows: [...map.values()].sort((a, b) => b.turns - a.turns), hasBreakdown: false, hasCost: false, breakdownDays: 0, totalDays: days.length }
  }
  type Row = Split & { model: string; speed: string; shareSum: number }
  const rows = new Map<string, Row>()
  const keyOf = (m: string, s: string) => `${m} ${s}`
  for (const d of withBreakdown) {
    const total = d.model_shares.reduce((s, m) => s + Math.max(0, m.percent), 0)
    for (const m of d.model_shares) {
      if (m.percent <= 0) continue
      const model = (m.model ?? '').trim() || '-'
      const speed = (m.speed ?? '').trim().toLowerCase() || 'standard'
      const share = total > 0 ? m.percent / total : 0
      const credits = share * (d.credits || 0)
      const k = keyOf(model, speed)
      const row = rows.get(k) ?? { label: speed === 'standard' ? model : `${model} · ${speed}`, model, speed, credits: 0, usd: 0, turns: 0, tokens: 0, share: 0, shareSum: 0 }
      row.credits += credits
      row.usd += credits / perUsd
      row.shareSum += share
      rows.set(k, row)
    }
  }
  const turnsByModel = new Map<string, number>()
  for (const d of withBreakdown) {
    for (const m of d.models ?? []) {
      const model = (m.model ?? '').trim() || '-'
      turnsByModel.set(model, (turnsByModel.get(model) ?? 0) + (m.turns ?? 0))
    }
  }
  for (const [model, turns] of turnsByModel) {
    const standard = rows.get(keyOf(model, 'standard'))
    if (standard) {
      standard.turns += turns
      continue
    }
    const sibling = [...rows.values()].find((r) => r.model === model)
    if (sibling) {
      sibling.turns += turns
      continue
    }
    rows.set(keyOf(model, 'standard'), { label: model, model, speed: 'standard', credits: 0, usd: 0, turns, tokens: 0, share: 0, shareSum: 0 })
  }
  const n = withBreakdown.length
  const out: Split[] = [...rows.values()].map((r) => ({ label: r.label, credits: r.credits, usd: r.usd, turns: r.turns, tokens: 0, share: n > 0 ? r.shareSum / n : 0 }))
  const hasCost = out.some((r) => r.usd > 0)
  out.sort((a, b) => (hasCost ? b.usd - a.usd || b.turns - a.turns : b.share - a.share || b.turns - a.turns))
  return { rows: out, hasBreakdown: true, hasCost, breakdownDays: n, totalDays: days.length }
}

function SplitTable({ title, rows, costMode = 'usd', footnote }: { title: string; rows: Split[]; costMode?: 'usd' | 'share' | 'none'; footnote?: string }) {
  return (
    <Section title={title}>
      {rows.length ? (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatInt(r.turns)} 轮</span>
              {costMode === 'usd' ? (
                <span className="w-20 text-right font-semibold tabular-nums" title={`${formatCredits(r.credits)} credits`}>
                  {formatUSD(r.usd)}
                </span>
              ) : costMode === 'share' ? (
                <span className="w-20 text-right font-semibold tabular-nums" title="窗口内的平均日份额">
                  {formatShare(r.share)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">没有数据</p>
      )}
      {footnote ? <p className="mt-3 text-[11px] text-muted-foreground">{footnote}</p> : null}
    </Section>
  )
}

export function OfficialTab({ accountId, range, full, quota, now, onSynced }: { accountId: string; range: UsageRange; full: boolean; quota: AccountQuota | null; now: number; onSynced?: () => void }) {
  const days = rangeToDays(range)
  const [data, setData] = useState<OfficialUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const seq = useRef(0)
  const autoRefreshed = useRef<string | null>(null)

  const load = useCallback(
    async (refresh: boolean) => {
      const my = ++seq.current
      if (refresh) setRefreshing(true)
      else setLoading(true)
      setError(null)
      try {
        if (refresh) {
          setRefreshError(null)
          try {
            await syncAccountOfficial(accountId, 7)
            onSynced?.()
          } catch (err) {
            if (seq.current === my) setRefreshError(err instanceof Error ? err.message : '同步失败')
          }
        }
        const result = await getAccountOfficial(accountId, days)
        if (seq.current !== my) return
        setData(result)
      } catch (err) {
        if (seq.current !== my) return
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        if (seq.current === my) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [accountId, days, onSynced],
  )

  // 每个账号只在首次进入时打一次上游;之后切换范围只读本地快照。
  useEffect(() => {
    const should = autoRefreshed.current !== accountId
    if (should) autoRefreshed.current = accountId
    void load(should)
  }, [load, accountId])

  const items = useMemo(() => data?.days ?? [], [data])
  const perUsd = data?.credits_per_usd || 25
  const totals = useMemo(() => {
    const credits = items.reduce((s, d) => s + (d.credits || 0), 0)
    return { credits, usd: credits / perUsd, tokens: items.reduce((s, d) => s + (d.total_tokens ?? 0), 0), turns: items.reduce((s, d) => s + d.turns, 0) }
  }, [items, perUsd])
  const maxCredits = items.reduce((m, d) => Math.max(m, d.credits || 0), 0)
  const clients = useMemo(() => aggregateClients(items, perUsd), [items, perUsd])
  const models = useMemo(() => aggregateModels(items, perUsd), [items, perUsd])
  const cycle = useMemo(() => cycleEstimate(quota, items, perUsd, now), [quota, items, perUsd, now])

  if (loading && !data) return <div className="py-12 text-center text-sm text-muted-foreground">加载中…</div>

  const reasonText = cycle.reason ? CYCLE_REASON_TEXT[cycle.reason] : ''
  const pctText = cycle.usedPercent == null ? '—' : `${Number.isInteger(cycle.usedPercent) ? cycle.usedPercent : cycle.usedPercent.toFixed(1)}%`
  const estimateDetail = cycle.estimate
    ? [`区间 ${formatUSD(cycle.estimate.low)} – ${formatUSD(cycle.estimate.high)}`, cycle.estimate.reliable ? '' : '已用不足 10%,估算不可靠'].filter(Boolean).join(' · ')
    : reasonText

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">官方结算</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">上游可回溯约 84 天,本地保留同步过的全部记录</span>
        </div>
        <div className="flex items-center gap-2">
          {data?.sync?.last_sync_at ? <span className="text-[11px] text-muted-foreground">上次同步 {formatDateTimeFull(data.sync.last_sync_at)}</span> : null}
          <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </div>

      {error ? <Banner tone="error">{error}</Banner> : null}
      {refreshError ? <Banner tone="warn">同步官方数据失败:{refreshError}。下面仍是本地快照。</Banner> : null}
      {!refreshError && data?.sync?.last_error ? <Banner tone="warn">后台上次同步失败:{data.sync.last_error}</Banner> : null}

      {!items.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">官方还没有这个账号的结算数据。官方统计通常滞后一天,新账号需要等一等。</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <CompactMetric icon={Banknote} label="官方成本" value={formatUSD(totals.usd)} detail={`${formatCredits(totals.credits)} credits · 1 美元 = ${perUsd} credits`} />
            <CompactMetric icon={Package} label="官方 Token" value={formatCompact(totals.tokens, full)} />
            <CompactMetric icon={Zap} label="轮次" value={formatInt(totals.turns)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <CompactMetric
              icon={Coins}
              label="本周期已用"
              value={formatUSD(cycle.usedUsd)}
              detail={cycle.startAt ? `${cycle.days} 天有结算 · 周期从 ${formatDateTimeFull(cycle.startAt)} 起` : reasonText || undefined}
            />
            <CompactMetric
              icon={Gauge}
              label="实时已用百分比"
              value={pctText}
              detail={cycle.resetAt ? `${formatDateTimeFull(cycle.resetAt)} 重置 · 探测于 ${cycle.percentUpdatedAt ? formatDateTimeFull(cycle.percentUpdatedAt) : '—'}` : reasonText}
            />
            <div title="估算 = 本周期官方已用成本 ÷ 实时已用百分比。百分比只有整数精度,所以给出 ±0.5% 的区间。">
              <CompactMetric icon={BarChart3} label="周期总额度估算" value={cycle.estimate ? formatUSD(cycle.estimate.usd) : '无法估算'} detail={estimateDetail || undefined} />
            </div>
          </div>

          <Section title="每日趋势" description="条长按 credits;未结算(当天)的 token 带 * 号,数值还会变。">
            <div className="space-y-1.5">
              {[...items].reverse().map((d) => {
                const width = maxCredits > 0 ? Math.max(2, ((d.credits || 0) / maxCredits) * 100) : 0
                return (
                  <div key={d.day} className="flex items-center gap-3 text-xs">
                    <span className="w-14 shrink-0 font-mono text-muted-foreground">{d.day.slice(5)}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-muted/50">
                      <div className="h-full rounded bg-primary/70" style={{ width: `${width}%` }} />
                    </div>
                    <span className="w-20 text-right font-semibold tabular-nums" title={`${formatCredits(d.credits || 0)} credits`}>
                      {formatUSD((d.credits || 0) / perUsd)}
                    </span>
                    <span className="w-20 text-right tabular-nums text-muted-foreground" title={d.settled ? undefined : '未结算,数值还在变'}>
                      {(d.total_tokens ?? 0) > 0 ? formatCompact(d.total_tokens ?? 0, full) : '未结算'}
                      {(d.total_tokens ?? 0) > 0 && !d.settled ? <span className="ml-0.5 text-[10px] opacity-70">*</span> : null}
                    </span>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">{formatInt(d.turns)} 轮</span>
                  </div>
                )
              })}
            </div>
          </Section>

          <div className="grid gap-3 lg:grid-cols-2">
            <SplitTable title="按客户端入口" rows={clients} />
            <SplitTable
              title="按模型"
              rows={models.rows}
              costMode={!models.hasBreakdown ? 'none' : models.hasCost ? 'usd' : 'share'}
              footnote={models.hasBreakdown && models.breakdownDays < models.totalDays ? `模型拆分只覆盖 ${models.breakdownDays} / ${models.totalDays} 天` : undefined}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            数据源 <span className="font-mono">{data?.source}</span>。「网关 / 未标识」一档就是经本网关转发的流量,其余是官方客户端直接产生的消耗。
          </p>
        </>
      )}
    </div>
  )
}
