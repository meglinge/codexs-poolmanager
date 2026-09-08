import { Activity, Clock3, Gauge, Package, ShieldCheck, Zap } from 'lucide-react'

import type { AccountUsage, DayStat, UsageRange } from '@/api/usage'
import { QuotaPanel } from '@/components/pool/QuotaWindows'
import { formatCompact, formatDate } from '@/lib/usage-format'

import { CompactMetric, HighlightStrip, SignalCard } from './shared'
import { formatCost, formatDurationMs, formatInt, rangeDays, todayKey } from './lib'

const EMPTY_DAY: DayStat = { day: '', requests: 0, errors: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, cost_usd: 0, avg_latency_ms: 0 }

function UsageTrend({ history, full }: { history: DayStat[]; full: boolean }) {
  const display = history.slice(-60)
  const maxCost = Math.max(0, ...display.map((d) => d.cost_usd))
  const maxReq = Math.max(0, ...display.map((d) => d.requests))
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">用量趋势</p>
          <p className="text-xs text-muted-foreground">{display.length ? `最近 ${display.length} 天,柱高按成本(没有成本时按请求数)` : '这段时间没有请求'}</p>
        </div>
        {display.length ? (
          <div className="text-right text-[11px] text-muted-foreground">
            <div>最高成本日 ${formatCost(maxCost)}</div>
            <div>最高请求日 {formatCompact(maxReq, full)}</div>
          </div>
        ) : null}
      </div>
      {display.length ? (
        <div className="flex h-20 items-end gap-1 rounded-xl border border-border/80 bg-background px-2 py-2">
          {display.map((d) => {
            const h = maxCost > 0 ? Math.max(8, (d.cost_usd / maxCost) * 100) : Math.max(8, (d.requests / Math.max(maxReq, 1)) * 100)
            return (
              <div
                key={d.day}
                className="min-w-[3px] flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
                style={{ height: `${h}%` }}
                title={`${d.day}: $${formatCost(d.cost_usd)} / ${formatInt(d.requests)} 请求`}
              />
            )
          })}
        </div>
      ) : (
        <div className="flex h-20 items-center justify-center rounded-xl border border-border/80 bg-background text-xs text-muted-foreground">没有数据</div>
      )}
    </div>
  )
}

export function OverviewTab({ data, range, full, now }: { data: AccountUsage; range: UsageRange; full: boolean; now: number }) {
  const t = data.totals
  const days = data.by_day
  const periodDays = rangeDays(range)
  const activeDays = days.filter((d) => d.requests > 0).length
  const divisor = periodDays > 0 ? periodDays : Math.max(1, activeDays)
  const today = days.find((d) => d.day === todayKey()) ?? EMPTY_DAY
  const highestCost = days.reduce((best, d) => (d.cost_usd > best.cost_usd ? d : best), EMPTY_DAY)
  const highestReq = days.reduce((best, d) => (d.requests > best.requests ? d : best), EMPTY_DAY)
  const topModel = data.by_model[0]
  const totalTokens = t.input_tokens + t.output_tokens
  const rangeLabel = range === 'all' ? '全部时间' : range === '24h' ? '最近 24 小时' : `最近 ${periodDays} 天`
  const activeText = periodDays > 0 ? `${activeDays} / ${periodDays}` : `${activeDays} 天`

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <div className="rounded-2xl border border-border/80 bg-gradient-to-br from-background via-background to-accent/40 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">{rangeLabel}网关估算成本</p>
              <p className="mt-1 text-5xl font-semibold tracking-tight tabular-nums">${formatCost(t.cost_usd)}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs">
                <div className="text-muted-foreground">成功</div>
                <div className="font-semibold tabular-nums">{formatInt(t.success)}</div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs">
                <div className="text-muted-foreground">失败</div>
                <div className={`font-semibold tabular-nums ${t.errors > 0 ? 'text-destructive' : ''}`}>{formatInt(t.errors)}</div>
              </div>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <CompactMetric icon={Zap} label="总请求" value={formatCompact(t.requests, full)} />
            <CompactMetric icon={Package} label="总 Token" value={formatCompact(totalTokens, full)} />
            <CompactMetric icon={Clock3} label="平均耗时" value={formatDurationMs(t.avg_latency_ms)} />
          </div>
          <UsageTrend history={days} full={full} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <SignalCard
            icon={Activity}
            title="今日概览"
            rows={[
              { label: '请求', value: formatInt(today.requests) },
              { label: 'Token', value: formatCompact(today.input_tokens + today.output_tokens, full) },
              { label: '今日成本', value: `$${formatCost(today.cost_usd)}` },
            ]}
          />
          <SignalCard
            icon={Gauge}
            title="日均基线"
            rows={[
              { label: '日均成本', value: `$${formatCost(t.cost_usd / divisor)}` },
              { label: '日均请求', value: formatCompact(Math.round(t.requests / divisor), full) },
              { label: '活跃天数', value: activeText },
            ]}
          />
          <div className="sm:col-span-2 lg:col-span-1">
            <SignalCard icon={ShieldCheck} title="官方额度窗口">
              <QuotaPanel quota={data.quota} now={now} />
            </SignalCard>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <HighlightStrip label="最高成本日" value={highestCost.day ? formatDate(highestCost.day) : '-'} detail={`$${formatCost(highestCost.cost_usd)} · ${formatInt(highestCost.requests)} 请求`} />
        <HighlightStrip label="最高请求日" value={highestReq.day ? formatDate(highestReq.day) : '-'} detail={`${formatCompact(highestReq.requests, full)} 请求 · $${formatCost(highestReq.cost_usd)}`} />
        <HighlightStrip
          label="主要模型"
          value={topModel?.model || '-'}
          detail={topModel ? `${formatInt(topModel.requests)} 请求 · ${formatCompact(topModel.input_tokens + topModel.output_tokens, full)} tok` : '-'}
        />
      </div>
    </div>
  )
}
