import { useMemo, useState } from 'react'

import type { HealthBucket } from '@/api/usage'
import { buildBlocks, rateColor } from '@/lib/health'
import { formatPct } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

/**
 * 账号健康条:最近 N 个时间桶(默认 20 × 10 分钟)的成功/失败,每桶一格。
 * 颜色是成功率,没请求的桶用边框色;右侧是整段成功率。
 */

const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function HealthBar({
  buckets,
  count = 20,
  minutes = 10,
  now = Date.now(),
  className,
}: {
  buckets: HealthBucket[] | undefined
  count?: number
  minutes?: number
  now?: number
  className?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const blocks = useMemo(() => buildBlocks(buckets, count, minutes, now), [buckets, count, minutes, now])
  const success = blocks.reduce((s, b) => s + b.success, 0)
  const failed = blocks.reduce((s, b) => s + b.failed, 0)
  const total = success + failed
  const rate = total ? (success / total) * 100 : null
  const badge =
    rate == null
      ? 'bg-muted text-muted-foreground'
      : rate >= 90
        ? 'bg-accent text-primary'
        : rate >= 50
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
          : 'bg-destructive/10 text-destructive'

  return (
    <div className={cn('flex min-w-[150px] items-center gap-2', className)}>
      <div className="relative flex flex-1 gap-[2px]" onMouseLeave={() => setActive(null)}>
        {blocks.map((b, i) => (
          <div key={b.start} className="relative flex-1 cursor-default py-1" onMouseEnter={() => setActive(i)}>
            <div
              className={cn('h-1.5 w-full rounded-[2px] transition-transform', active === i && 'scale-y-[1.8]')}
              style={{ backgroundColor: b.rate == null ? 'hsl(var(--border))' : rateColor(b.rate) }}
            />
            {active === i ? (
              <div
                className={cn(
                  'pointer-events-none absolute bottom-[calc(100%+4px)] z-30 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md',
                  i <= 2 ? 'left-0' : i >= blocks.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                )}
              >
                <div className="text-muted-foreground">
                  {clock(b.start)} – {clock(b.end)}
                </div>
                {b.success + b.failed > 0 ? (
                  <div className="flex gap-2">
                    <span className="text-primary">成功 {b.success}</span>
                    <span className="text-destructive">失败 {b.failed}</span>
                    <span className="text-muted-foreground">{formatPct((b.rate ?? 0) * 100)}</span>
                  </div>
                ) : (
                  <div className="text-muted-foreground">没有请求</div>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <span className={cn('inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums', badge)}>
        {rate == null ? '--' : formatPct(rate)}
      </span>
    </div>
  )
}
