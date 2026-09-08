import { useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'

import { consumeResetCredit, type AccountQuota } from '@/api/usage'
import { Button } from '@/components/ui/button'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { formatDateTimeFull } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

/**
 * 重置额度:官方发的「限流重置券」。列出每张券的有效期(最快过期的在前,7 天内到期标琥珀),
 * 两段确认后消费一张,立即重置 5h / 7d 窗口。消费不可撤销,后端带幂等键。
 */
export function ResetCredits({ accountId, quota, now, onChanged }: { accountId: string; quota: AccountQuota | null; now: number; onChanged: (q: AccountQuota | null) => void }) {
  const { showToast } = useGlobalToast()
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const credits = useMemo(() => {
    const list = quota?.reset_credits ?? []
    return list
      .filter((c) => c.reset_type === 'codex_rate_limits' && c.status === 'available')
      .map((c, i) => {
        const until = c.consumable_until || c.expires_at || null
        const ms = until ? new Date(until).getTime() : Number.NaN
        return { key: c.id || String(i), until, ms, title: c.title }
      })
      .filter((c) => Number.isFinite(c.ms))
      .sort((a, b) => a.ms - b.ms || a.key.localeCompare(b.key))
  }, [quota])

  if (!quota) return null
  const count = quota.reset_credits_available
  const applicable = quota.reset_credits_applicable
  const cr = quota.credits
  const balance = cr?.has_credits ? (cr.unlimited ? '无限' : (cr.balance ?? '').trim() || null) : null

  const reset = async () => {
    setResetting(true)
    setError(null)
    try {
      const res = await consumeResetCredit(accountId)
      setDone(true)
      setConfirming(false)
      showToast('success', '已重置额度')
      onChanged(res.quota ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border/80 bg-card p-4">
      {balance != null ? (
        <div className="mb-3 flex items-center justify-between gap-4 rounded-xl bg-muted/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">积分余额</span>
          <span className="flex items-center gap-2 text-base font-semibold tabular-nums">
            {balance}
            {cr?.overage_limit_reached ? <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">已达超额上限</span> : null}
          </span>
        </div>
      ) : null}
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
      {done && !error ? <p className="mb-3 text-xs text-primary">已重置,额度窗口会在下一次探测后更新。</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">重置额度</p>
          <p className="text-xs text-muted-foreground">官方赠送的限流重置券,消费一张立即清空 5h / 7d 窗口。</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{count}</div>
            {count > 0 && applicable === 0 ? <div className="text-[10px] text-muted-foreground">未触限时不可用</div> : null}
          </div>
          {count > 0 && !confirming ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => {
                setDone(false)
                setConfirming(true)
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重置
            </Button>
          ) : null}
          {confirming ? (
            <>
              <Button size="sm" className="h-8" disabled={resetting} onClick={reset}>
                {resetting ? '重置中…' : '确认消费一张'}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" disabled={resetting} onClick={() => setConfirming(false)}>
                取消
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {confirming ? <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">消费后不可撤销;未触限时上游可能拒绝(applicable 为 0)。</p> : null}
      {credits.length ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <p className="mb-2 text-xs font-medium">重置券有效期</p>
          <ul className="space-y-1">
            {credits.map((c, i) => {
              const soon = c.ms - now <= 7 * 86400 * 1000
              return (
                <li key={c.key} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">
                    第 {i + 1} 张{c.title ? ` · ${c.title}` : ''}
                  </span>
                  <span className={cn('tabular-nums', soon ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-foreground')}>{formatDateTimeFull(c.until)} 到期</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
