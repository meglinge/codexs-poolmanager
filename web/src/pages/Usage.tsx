import { useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { getRecentUsage, getUsageSummary, type UsageBucket } from '@/api/pool'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, formatNumber } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

const RANGES: Array<[number, string]> = [
  [1, '1 小时'],
  [24, '24 小时'],
  [168, '7 天'],
  [720, '30 天'],
]

function BucketTable({ rows, first }: { rows: UsageBucket[]; first: string }) {
  return (
    <div className="ops-table-shell border-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{first}</TableHead>
            <TableHead className="text-right">请求</TableHead>
            <TableHead className="text-right">错误</TableHead>
            <TableHead className="text-right">输入</TableHead>
            <TableHead className="text-right">输出</TableHead>
            <TableHead className="text-right">缓存</TableHead>
            <TableHead className="text-right">延迟</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((b) => (
              <TableRow key={b.key ?? 'none'}>
                <TableCell className="font-medium">{b.name ?? '(已删除)'}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.requests)}</TableCell>
                <TableCell className={cn('text-right tabular-nums', b.errors > 0 && 'text-destructive')}>{formatNumber(b.errors)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.input_tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.output_tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.cached_tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{Math.round(b.avg_latency_ms)} ms</TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={7}>
                <EmptyState title="这段时间没有请求" />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export default function Usage() {
  const [hours, setHours] = useState(24)
  const summary = useResource(() => getUsageSummary(hours), [hours])
  const recent = useResource(() => getRecentUsage(100), [])
  const refresh = () => {
    summary.refresh()
    recent.refresh()
  }
  const loading = summary.loading || recent.loading

  return (
    <PageShell
      title="用量"
      description="请求数、token 与延迟,按 key 和按账号汇总。"
      width="7xl"
      actions={
        <>
          <div className="flex rounded-md border border-border/70 bg-background/80 p-0.5">
            {RANGES.map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={hours === value ? 'default' : 'ghost'}
                size="sm"
                className="h-7 rounded-md px-2.5 text-xs"
                onClick={() => setHours(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </Button>
        </>
      }
    >
      {summary.error ? (
        <PageSurface>
          <ErrorState message={summary.error} onRetry={summary.refresh} />
        </PageSurface>
      ) : !summary.data ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <PageSurface title="按 API key" bodyClassName="p-0">
            <BucketTable rows={summary.data.by_key} first="Key" />
          </PageSurface>
          <PageSurface title="按账号" bodyClassName="p-0">
            <BucketTable rows={summary.data.by_account} first="账号" />
          </PageSurface>
        </div>
      )}

      <PageSurface title="最近请求" description="最新 100 条。" bodyClassName="p-0">
        {recent.error ? (
          <ErrorState message={recent.error} onRetry={recent.refresh} />
        ) : !recent.data ? (
          <div className="flex h-32 items-center justify-center">
            <InlineLoader />
          </div>
        ) : (
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>路径</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">延迟</TableHead>
                  <TableHead className="text-right">输入 / 输出 / 缓存</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.data.length ? (
                  recent.data.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(u.ts)}</TableCell>
                      <TableCell className="font-mono text-xs">{u.path}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 font-mono text-xs font-semibold',
                            u.status >= 400 ? 'bg-destructive/10 text-destructive' : 'bg-accent text-primary',
                          )}
                        >
                          {u.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{u.latency_ms} ms</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(u.input_tokens)} / {formatNumber(u.output_tokens)} / {formatNumber(u.cached_tokens)}
                      </TableCell>
                      <TableCell className="max-w-[36ch] truncate text-xs text-muted-foreground" title={u.error ?? ''}>
                        {u.error || ''}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyState title="还没有请求记录" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </PageSurface>
    </PageShell>
  )
}
