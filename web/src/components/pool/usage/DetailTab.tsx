import { useMemo, useState } from 'react'
import { KeyRound, Package } from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import type { AccountUsage, KeyStat, ModelStat, UsageRange } from '@/api/usage'
import { formatCompact } from '@/lib/usage-format'

import { Kpi, PillGroup, Section } from './shared'
import { COLORS, METRIC_OPTIONS, formatCost, formatDurationMs, formatInt, formatPercent2, metricValue, rangeDays, type MetricKey } from './lib'

const fmtMetric = (v: number, metric: MetricKey, full: boolean) =>
  metric === 'tokens' ? formatCompact(v, full) : metric === 'cost' ? `$${formatCost(v)}` : formatInt(v)

const metricLabel = (m: MetricKey) => METRIC_OPTIONS.find((o) => o.key === m)?.label ?? ''

function detailText(m: { requests: number; input_tokens: number; output_tokens: number; cost_usd: number }, metric: MetricKey, full: boolean) {
  const req = `${formatInt(m.requests)} 请求`
  const tok = `${formatCompact(m.input_tokens + m.output_tokens, full)} tok`
  const cost = `$${formatCost(m.cost_usd)}`
  return metric === 'tokens' ? `${req} · ${cost}` : metric === 'cost' ? `${req} · ${tok}` : `${tok} · ${cost}`
}

function ShareRow({ name, badge, value, total, color, metric, full, item }: { name: string; badge?: string; value: number; total: number; color: string; metric: MetricKey; full: boolean; item: ModelStat | KeyStat }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0
  return (
    <div className="rounded-xl border border-border/80 bg-background px-3 py-2.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-sm">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{name}</span>
          {badge ? <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted-foreground">{badge}</span> : null}
        </span>
        <span className="tabular-nums text-muted-foreground">{formatPercent2(pct)}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold tabular-nums">{fmtMetric(value, metric, full)}</span>
        <span className="truncate text-muted-foreground">{detailText(item, metric, full)}</span>
      </div>
    </div>
  )
}

function TokenBar({ label, value, total, full }: { label: string; value: number; total: number; full: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{formatCompact(value, full)}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function DetailTab({ data, range, full }: { data: AccountUsage; range: UsageRange; full: boolean }) {
  const [modelMetric, setModelMetric] = useState<MetricKey>('requests')
  const [keyMetric, setKeyMetric] = useState<MetricKey>('requests')
  const t = data.totals
  const totalTokens = t.input_tokens + t.output_tokens

  const models = useMemo(
    () =>
      [...data.by_model]
        .sort((a, b) => metricValue(b, modelMetric) - metricValue(a, modelMetric) || b.requests - a.requests)
        .map((m) => ({ ...m, name: m.model || '(未知)', metric_value: metricValue(m, modelMetric) })),
    [data.by_model, modelMetric],
  )
  const modelTotal = models.reduce((s, m) => s + m.metric_value, 0)

  const keys = useMemo(
    () => [...data.by_key].sort((a, b) => metricValue(b, keyMetric) - metricValue(a, keyMetric) || b.requests - a.requests),
    [data.by_key, keyMetric],
  )
  const keyTotal = keys.reduce((s, k) => s + metricValue(k, keyMetric), 0)

  const periodDays = rangeDays(range)
  const activeDays = data.by_day.filter((d) => d.requests > 0).length
  const divisor = periodDays > 0 ? periodDays : Math.max(1, activeDays)
  const cacheHitRate = t.requests > 0 ? (t.cached_hits / t.requests) * 100 : 0

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Section
          title="模型分布"
          description={models[0] ? `按${metricLabel(modelMetric)}排,最多的是 ${models[0].name}` : '这段时间没有请求'}
          actions={
            <>
              <span className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-semibold tabular-nums">
                {fmtMetric(modelTotal, modelMetric, full)} {metricLabel(modelMetric)}
              </span>
              <PillGroup value={modelMetric} onChange={setModelMetric} options={METRIC_OPTIONS} size="xs" />
            </>
          }
        >
          {models.length ? (
            <div className="grid gap-4 md:grid-cols-[230px_minmax(0,1fr)]">
              <div className="h-[230px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={models} dataKey="metric_value" nameKey="name" cx="50%" cy="50%" innerRadius={62} outerRadius={92} paddingAngle={0} strokeWidth={0}>
                      {models.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value, name) => [fmtMetric(Number(value || 0), modelMetric, full), String(name ?? '')]}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-2 self-center">
                {models.map((m, i) => (
                  <ShareRow key={m.name} name={m.name} value={m.metric_value} total={modelTotal} color={COLORS[i % COLORS.length]} metric={modelMetric} full={full} item={m} />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 text-xs text-muted-foreground">没有数据</div>
          )}
        </Section>

        <Section title="Token 构成" description="分母是输入 + 输出;缓存是输入的子集,推理计入输出。">
          <div className="space-y-4">
            <TokenBar label="输入" value={t.input_tokens} total={totalTokens} full={full} />
            <TokenBar label="输出" value={t.output_tokens} total={totalTokens} full={full} />
            <TokenBar label="推理" value={t.reasoning_tokens} total={totalTokens} full={full} />
            <TokenBar label="缓存命中" value={t.cached_tokens} total={totalTokens} full={full} />
          </div>
        </Section>
      </div>

      <Section
        title={
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-3.5 w-3.5" />
            </span>
            Key 分布
          </span>
        }
        description={keys.length ? `按${metricLabel(keyMetric)}排,最多的是 ${keys[0].name ?? '(已删除)'}` : '哪些下游 key 用了这个账号'}
        actions={
          <>
            <span className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-semibold tabular-nums">
              {fmtMetric(keyTotal, keyMetric, full)} {metricLabel(keyMetric)}
            </span>
            {keys.length ? <span className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-semibold">{keys.length} 个 key</span> : null}
            <PillGroup value={keyMetric} onChange={setKeyMetric} options={METRIC_OPTIONS} size="xs" />
          </>
        }
      >
        {keys.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {keys.map((k, i) => (
              <ShareRow
                key={`${k.api_key_id ?? 'none'}-${i}`}
                name={k.name ?? '(已删除)'}
                badge={k.key_prefix ? `${k.key_prefix}…` : undefined}
                value={metricValue(k, keyMetric)}
                total={keyTotal}
                color={COLORS[i % COLORS.length]}
                metric={keyMetric}
                full={full}
                item={k}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-muted/20 text-xs text-muted-foreground">
            <KeyRound className="h-4 w-4 opacity-60" />
            这段时间没有 key 调用过这个账号
          </div>
        )}
      </Section>

      <div className="grid gap-3 md:grid-cols-4">
        <Kpi label="活跃天数" value={periodDays > 0 ? `${activeDays} / ${periodDays}` : `${activeDays} 天`} />
        <Kpi label="日均 Token" value={formatCompact(Math.round(totalTokens / divisor), full)} />
        <Kpi label="缓存命中率" value={formatPercent2(cacheHitRate)} />
        <Kpi label="平均耗时" value={formatDurationMs(t.avg_latency_ms)} />
      </div>
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Package className="h-3 w-3" />
        缓存命中率 = 命中缓存的请求数 ÷ 总请求数;成本按内置价格表估算,官方结算见「官方」页签。
      </p>
    </div>
  )
}
