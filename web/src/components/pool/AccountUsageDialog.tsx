import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, BarChart3, Gauge, ListOrdered, Package, Receipt } from 'lucide-react'

import { getAccountUsage, refreshAccountQuota, type AccountQuota, type AccountUsage, type UsageRange } from '@/api/usage'
import { StatusBadge } from '@/components/pool/StatusBadge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import { DetailTab } from './usage/DetailTab'
import { OfficialTab } from './usage/OfficialTab'
import { OverviewTab } from './usage/OverviewTab'
import { QualityTab } from './usage/QualityTab'
import { RequestsTab } from './usage/RequestsTab'
import { ResetCredits } from './usage/ResetCredits'
import { PillGroup } from './usage/shared'
import { RANGE_OPTIONS, useFullNumbers } from './usage/lib'

export type UsageTab = 'overview' | 'detail' | 'quality' | 'official' | 'requests'

const TABS: Array<{ key: UsageTab; label: string; icon: typeof Gauge }> = [
  { key: 'overview', label: '概览', icon: Gauge },
  { key: 'detail', label: '明细', icon: Package },
  { key: 'quality', label: '质量', icon: Activity },
  { key: 'official', label: '官方', icon: Receipt },
  { key: 'requests', label: '请求', icon: ListOrdered },
]

export interface UsageTarget {
  id: string
  name: string
  tab?: UsageTab
}

/**
 * 账号用量面板。左上是账号与范围,右上是状态、页签;第二行是范围选择器,
 * 所有页签共享同一个 range。官方页不依赖网关记录,单独加载。
 */
export function AccountUsageDialog({ target, onClose }: { target: UsageTarget | null; onClose: () => void }) {
  const [tab, setTab] = useState<UsageTab>(target?.tab ?? 'overview')
  const [range, setRange] = useState<UsageRange>('30d')
  const [data, setData] = useState<AccountUsage | null>(null)
  const [dataRange, setDataRange] = useState<UsageRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useFullNumbers()
  const [now, setNow] = useState(() => Date.now())
  const seq = useRef(0)
  const id = target?.id ?? null

  useEffect(() => {
    setTab(target?.tab ?? 'overview')
    setData(null)
    setDataRange(null)
  }, [target?.id, target?.tab])

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    if (!id) return
    const my = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const result = await getAccountUsage(id, range)
      if (seq.current !== my) return
      setData(result)
      setDataRange(range)
    } catch (err) {
      if (seq.current !== my) return
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (seq.current === my) setLoading(false)
    }
  }, [id, range])

  useEffect(() => {
    void load()
  }, [load])

  const applyQuota = useCallback((q: AccountQuota | null) => {
    if (q) setData((d) => (d ? { ...d, quota: q } : d))
  }, [])

  const refreshQuota = useCallback(async () => {
    if (!id) return
    try {
      const r = await refreshAccountQuota(id)
      applyQuota(r.quota)
    } catch {
      /* 面板照旧显示上一份快照 */
    }
  }, [id, applyQuota])

  const officialReady = tab === 'official'
  const rangeLabel = dataRange === 'all' ? '全部时间' : dataRange ? (RANGE_OPTIONS.find((o) => o.key === dataRange)?.label ?? '') : ''

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto p-0 sm:max-w-[1000px]">
        <DialogHeader className="sr-only">
          <DialogTitle>用量统计 — {target?.name}</DialogTitle>
          <DialogDescription>账号 {target?.name} 的用量、质量与官方结算。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <BarChart3 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{target?.name}</p>
              <p className="text-xs text-muted-foreground">
                {rangeLabel ? `${rangeLabel}的统计` : '加载中…'}
                {loading && data ? ' · 更新中' : ''}
                {data?.quota?.plan_type ? ` · ${data.quota.plan_type}` : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {data ? <StatusBadge status={data.account.enabled ? data.account.status : 'stopped'} className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs" /> : null}
            <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'inline-flex h-7 min-w-16 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors',
                    tab === t.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3">
          <span className="text-xs font-semibold text-muted-foreground">范围</span>
          <PillGroup value={range} onChange={setRange} options={RANGE_OPTIONS} />
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={full} onCheckedChange={setFull} />
            完整数字
          </label>
        </div>

        <div className="space-y-5 px-5 py-5">
          {loading && !data && !officialReady ? (
            <div className="py-12 text-center text-sm text-muted-foreground">加载中…</div>
          ) : error && !data && !officialReady ? (
            <div className="py-8 text-center text-sm text-destructive">{error}</div>
          ) : !data && !officialReady ? (
            <div className="py-12 text-center text-sm text-muted-foreground">没有用量数据</div>
          ) : (
            <>
              {tab === 'overview' && data ? <OverviewTab data={data} range={dataRange ?? range} full={full} now={now} /> : null}
              {tab === 'detail' && data ? <DetailTab data={data} range={dataRange ?? range} full={full} /> : null}
              {tab === 'quality' && data ? <QualityTab data={data} /> : null}
              {tab === 'official' && id ? <OfficialTab accountId={id} range={range} full={full} quota={data?.quota ?? null} now={now} onSynced={refreshQuota} /> : null}
              {tab === 'requests' && id ? <RequestsTab accountId={id} range={range} models={data?.by_model ?? []} full={full} /> : null}
            </>
          )}
          {id && data ? <ResetCredits accountId={id} quota={data.quota} now={now} onChanged={applyQuota} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
