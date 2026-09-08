import type { ElementType } from 'react'
import { Activity, Clock3, Database, Gauge, Unplug, Zap } from 'lucide-react'

import type { AccountUsage } from '@/api/usage'
import { formatDateTime } from '@/lib/formatters'
import { cn } from '@/lib/utils'

import { Section } from './shared'
import { TONE, formatDurationMs, formatDurationOrDash, formatInt, formatPercent2, type Tone } from './lib'

function Metric({ icon: Icon, label, value, detail, tone = 'neutral' }: { icon: ElementType; label: string; value: string; detail: string; tone?: Tone }) {
  const c = TONE[tone]
  return (
    <div className={cn('rounded-xl border px-3 py-3', c.box)}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg', c.icon)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <div className={cn('mt-2 text-2xl font-semibold tabular-nums', c.value)}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

export function QualityTab({ data }: { data: AccountUsage }) {
  const t = data.totals
  const total = Math.max(0, t.requests)
  const of = (n: number) => `${formatInt(n)} / ${formatInt(total)} 个请求`
  const errorRate = total > 0 ? (t.errors / total) * 100 : 0
  const abortRate = total > 0 ? (t.client_aborts / total) * 100 : 0
  const streamRate = total > 0 ? (t.streams / total) * 100 : 0
  const cacheRate = total > 0 ? (t.cached_hits / total) * 100 : 0
  const ttft = t.avg_ttft_ms ?? 0

  return (
    <div className="space-y-4">
      <Section title="质量信号" description="这段时间经本网关转发到该账号的请求表现,全部来自网关自己的记录。">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Metric icon={Activity} label="错误率" value={formatPercent2(errorRate)} detail={of(t.errors)} tone={errorRate >= 10 ? 'danger' : errorRate >= 3 ? 'warning' : 'success'} />
          <Metric icon={Unplug} label="客户端中断" value={formatInt(t.client_aborts)} detail={`${of(t.client_aborts)} · ${formatPercent2(abortRate)}`} tone={t.client_aborts > 0 ? 'warning' : 'success'} />
          <Metric
            icon={Clock3}
            label="平均首字延迟"
            value={formatDurationOrDash(ttft)}
            detail={`${formatInt(t.streams)} 个样本 · P50 ${formatDurationOrDash(t.p50_ttft_ms ?? 0)}`}
            tone={ttft >= 5000 ? 'danger' : ttft >= 2000 ? 'warning' : 'neutral'}
          />
          <Metric
            icon={Gauge}
            label="P95 总耗时"
            value={formatDurationOrDash(t.p95_latency_ms)}
            detail={`${formatInt(total)} 个样本 · P50 ${formatDurationOrDash(t.p50_latency_ms)}`}
            tone={t.p95_latency_ms >= 30000 ? 'danger' : t.p95_latency_ms >= 10000 ? 'warning' : 'neutral'}
          />
          <Metric icon={Zap} label="流式占比" value={formatPercent2(streamRate)} detail={of(t.streams)} />
          <Metric icon={Database} label="缓存命中率" value={formatPercent2(cacheRate)} detail={of(t.cached_hits)} tone={cacheRate >= 50 ? 'success' : 'neutral'} />
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="按状态码" description="最近一次错误信息随状态码一起给出。">
          {data.by_status.length ? (
            <div className="space-y-1.5">
              {data.by_status.map((s) => (
                <div key={s.status} className="flex items-center gap-3 text-xs">
                  <span className={cn('inline-flex w-12 justify-center rounded-full px-2 py-0.5 font-mono font-semibold', s.status >= 400 ? 'bg-destructive/10 text-destructive' : 'bg-accent text-primary')}>{s.status}</span>
                  <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{formatInt(s.requests)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.last_error ?? ''}>
                    {s.last_error || (s.status < 400 ? '正常' : '')}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{s.last_ts ? formatDateTime(s.last_ts) : ''}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">没有数据</p>
          )}
        </Section>
        <Section title="按端点" description="流式与非流式分开统计。">
          {data.by_endpoint.length ? (
            <div className="space-y-1.5">
              {data.by_endpoint.map((e) => (
                <div key={`${e.path}-${e.stream}`} className="flex items-center gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono">{e.path}</span>
                  <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', e.stream ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground')}>{e.stream ? 'stream' : 'sync'}</span>
                  <span className="w-14 shrink-0 text-right font-semibold tabular-nums">{formatInt(e.requests)}</span>
                  <span className={cn('w-10 shrink-0 text-right tabular-nums', e.errors > 0 ? 'text-destructive' : 'text-muted-foreground')}>{e.errors}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{formatDurationMs(e.avg_latency_ms)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">没有数据</p>
          )}
        </Section>
      </div>
    </div>
  )
}
