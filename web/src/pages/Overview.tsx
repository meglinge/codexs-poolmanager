import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'

import { getOverview, type OverviewAccount } from '@/api/pool'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageStat, PageStatStrip, PageSurface } from '@/components/layout/PageScaffold'
import { StatusBadge } from '@/components/pool/StatusBadge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

/**
 * 总览:池子现在什么样。最醒目的元素是每个账号一行的「容量条」——
 * 条长 = 在途 / 上限,颜色 = 状态,一眼看出负载分布;其余全部克制。
 */

const REFRESH_MS = 5000

function Lane({ account }: { account: OverviewAccount }) {
  const status = account.enabled ? account.status : 'stopped'
  const pct = Math.min(100, Math.round((100 * account.inflight) / Math.max(1, account.max_concurrency)))
  const fill =
    status === 'running' ? '' : status === 'starting' || status === 'unhealthy' ? 'pm-lane-fill-warn' : 'pm-lane-fill-idle'
  return (
    <div className="pm-lane">
      <div className="min-w-0">
        <div className="truncate font-semibold">{account.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {account.runner_id}:{account.port}
          {account.chatgpt_account_id ? `  账号 ${account.chatgpt_account_id.slice(0, 8)}` : ''}
        </div>
      </div>
      <div className="pm-lane-bar">
        <div className={cn('pm-lane-fill', fill)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 md:flex-col md:items-end md:gap-0.5">
        <StatusBadge status={status} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {account.inflight} / {account.max_concurrency}
        </span>
      </div>
      {account.last_error ? (
        <div className="text-xs text-destructive md:col-span-3 md:-mt-2">{account.last_error}</div>
      ) : null}
    </div>
  )
}

export default function Overview() {
  const { data, loading, error, refresh } = useResource(() => getOverview(), [])

  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const inflight = data?.accounts.reduce((sum, a) => sum + a.inflight, 0) ?? 0
  const capacity = data?.accounts.filter((a) => a.status === 'running').reduce((sum, a) => sum + a.max_concurrency, 0) ?? 0

  return (
    <PageShell
      title="总览"
      description="账号池当前状态,每 5 秒刷新。"
      width="7xl"
      actions={
        <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          刷新
        </Button>
      }
    >
      {error ? (
        <PageSurface>
          <ErrorState message={error} onRetry={refresh} />
        </PageSurface>
      ) : !data ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <div className="space-y-6">
          <PageStatStrip className="md:grid-cols-3 xl:grid-cols-3">
            <PageStat label="运行中账号" value={`${data.accounts_running} / ${data.accounts_total}`} />
            <PageStat label="在途请求" value={`${inflight} / ${capacity}`} note="当前并发 / 运行中账号的总上限" />
            <PageStat label="Runner" value={data.runners} note={`副本 ${data.instance} · v${data.version}`} />
          </PageStatStrip>

          <PageSurface title="账号容量" description="条长是在途请求占上限的比例,颜色是状态。" bodyClassName="p-0">
            {data.accounts.length ? (
              data.accounts.map((account) => <Lane key={account.id} account={account} />)
            ) : (
              <EmptyState title="还没有账号" description="到「账号」页粘贴 auth.json 创建第一个。" />
            )}
          </PageSurface>
        </div>
      )}
    </PageShell>
  )
}
