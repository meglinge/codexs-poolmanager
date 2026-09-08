import type { AccountQuota } from '@/api/usage'
import { additionalWindows, fillTone, primaryWindows, type WindowView } from '@/lib/quota'
import { countdown, formatPct, relativeTime } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

/**
 * 官方额度窗口(/wham/usage)的渲染:主窗口(通常 5 小时 / 7 天)、次窗口,
 * 以及 spark / reserve 这类附加窗口。条长 = 已用百分比,80% 转琥珀,100% 转红。
 */

export function WindowBar({ w, now, compact }: { w: WindowView; now: number; compact?: boolean }) {
  const used = w.used == null ? null : Math.max(0, Math.min(100, w.used))
  const expired = w.resetAt ? new Date(w.resetAt).getTime() <= now : false
  return (
    <div
      className={cn(
        'grid items-center gap-x-3',
        compact ? 'grid-cols-[3rem_minmax(0,1fr)_3rem]' : 'grid-cols-[4.5rem_minmax(0,1fr)_3.5rem]',
      )}
    >
      <span className={cn('truncate text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>{w.label}</span>
      <div className="pm-lane-bar h-2">
        <div className={cn('pm-lane-fill', fillTone(used))} style={{ width: `${used ?? 0}%` }} />
      </div>
      <span className={cn('text-right font-semibold tabular-nums', compact ? 'text-[11px]' : 'text-xs')}>
        {formatPct(used, used != null && used < 10 ? 1 : 0)}
      </span>
      {!compact ? (
        <span className="col-span-3 text-[11px] text-muted-foreground">
          {w.resetAt
            ? expired
              ? `已在 ${relativeTime(w.resetAt, now)}重置`
              : `${countdown(w.resetAt, now)} 后重置`
            : '重置时间未知'}
        </span>
      ) : null}
    </div>
  )
}

/** 列表里的紧凑版:主/次窗口条 + 最近一次重置倒计时。 */
export function QuotaCompact({ quota, now }: { quota: AccountQuota | null | undefined; now: number }) {
  if (!quota) return <span className="text-xs text-muted-foreground">未探测</span>
  if (!quota.ok && quota.primary_used_percent == null) {
    return (
      <span className="text-xs text-destructive" title={quota.error ?? ''}>
        探测失败
      </span>
    )
  }
  const wins = primaryWindows(quota)
  if (!wins.length) return <span className="text-xs text-muted-foreground">无窗口</span>
  const soonest = [...wins].filter((w) => w.resetAt).sort((a, b) => new Date(a.resetAt!).getTime() - new Date(b.resetAt!).getTime())[0]
  return (
    <div className="w-[180px] space-y-1">
      {wins.map((w) => (
        <WindowBar key={w.label} w={w} now={now} compact />
      ))}
      <div className="flex items-center justify-between pl-[3.75rem] text-[11px] text-muted-foreground">
        <span>{soonest?.resetAt ? `⏱ ${countdown(soonest.resetAt, now)}` : ''}</span>
        {!quota.ok ? (
          <span className="text-amber-600 dark:text-amber-400" title={quota.error ?? ''}>
            {relativeTime(quota.fetched_at, now)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 面板里的完整版:主窗口 + 附加窗口 + 积分。 */
export function QuotaPanel({ quota, now }: { quota: AccountQuota | null | undefined; now: number }) {
  if (!quota) return <p className="text-sm text-muted-foreground">还没有探测到官方额度,后台每分钟探测一次。</p>
  const wins = primaryWindows(quota)
  const extra = additionalWindows(quota)
  const credits = quota.credits
  return (
    <div className="space-y-4">
      {!quota.ok ? (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          最近一次探测失败({quota.error}),下面是 {relativeTime(quota.fetched_at, now)}的数据。
        </div>
      ) : null}
      {wins.length ? (
        <div className="space-y-3">
          {wins.map((w) => (
            <WindowBar key={w.label} w={w} now={now} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">上游没有返回额度窗口。</p>
      )}
      {extra.length ? (
        <div className="space-y-3 border-t border-border/70 pt-3">
          {extra.map((l) => (
            <div key={l.name} className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{l.name}</span>
                {l.model ? <span className="font-mono text-muted-foreground">{l.model}</span> : null}
              </div>
              {l.windows.map((w) => (
                <WindowBar key={`${l.name}-${w.label}`} w={w} now={now} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {credits ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-xs text-muted-foreground">
          <span>
            积分余额{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {credits.unlimited ? '无限' : credits.has_credits ? Number(credits.balance ?? 0).toFixed(2) : '0'}
            </span>
          </span>
          {credits.overage_limit_reached ? <span className="text-destructive">已达超额上限</span> : null}
          {credits.approx_local_messages?.length === 2 ? (
            <span>
              约可再发 {credits.approx_local_messages[0]}–{credits.approx_local_messages[1]} 条本地消息
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {quota.plan_type ? `套餐 ${quota.plan_type}` : ''}
        {quota.email ? ` · ${quota.email}` : ''} · 探测于 {relativeTime(quota.fetched_at, now)}
      </p>
    </div>
  )
}
