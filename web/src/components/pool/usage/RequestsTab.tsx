import { useEffect, useState } from 'react'

import { getAccountRequests, type ModelStat, type RequestPage, type UsageRange } from '@/api/usage'
import { InlineLoader } from '@/components/PageLoader'
import { ErrorState } from '@/components/ui/error-state'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCompact, formatDateTimeFull, formatMs } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

import { formatCost } from './lib'

const PAGE = 50

export function RequestsTab({ accountId, range, models, full }: { accountId: string; range: UsageRange; models: ModelStat[]; full: boolean }) {
  const [model, setModel] = useState<string>('all')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<RequestPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setPage(1)
  }, [range, model, errorsOnly])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getAccountRequests(accountId, { range, model: model === 'all' ? undefined : model, errors_only: errorsOnly, limit: PAGE, offset: (page - 1) * PAGE })
      .then((r) => {
        if (!cancelled) setData(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, range, model, errorsOnly, page])

  const modelNames = models.map((m) => m.model).filter((m): m is string => Boolean(m))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue placeholder="全部模型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模型</SelectItem>
            {modelNames.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          只看失败
        </label>
        <span className="ml-auto text-xs text-muted-foreground">{data ? `${data.total} 条记录` : ''}</span>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => setPage((p) => p)} />
      ) : !data ? (
        <div className="flex h-40 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <div className={cn('ops-table-shell', loading && 'opacity-60')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>端点</TableHead>
                <TableHead className="text-right">Token</TableHead>
                <TableHead className="text-right">成本</TableHead>
                <TableHead className="text-right">首字</TableHead>
                <TableHead className="text-right">总耗时</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length ? (
                data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTimeFull(r.ts)}</TableCell>
                    <TableCell>
                      <span className={cn('inline-flex rounded-full px-2 py-0.5 font-mono text-xs font-semibold', r.status >= 400 ? 'bg-destructive/10 text-destructive' : 'bg-accent text-primary')}>{r.status}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <span className="font-mono text-xs">{r.model ?? '—'}</span>
                      {r.service_tier ? <span className="ml-1 rounded-md bg-amber-500/10 px-1 text-[10px] text-amber-700 dark:text-amber-400">{r.service_tier}</span> : null}
                    </TableCell>
                    <TableCell className="max-w-[12ch] truncate text-xs">{r.key_name ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <span className="font-mono text-xs">{r.path}</span>
                      <span className={cn('ml-1 rounded-md px-1 text-[10px] font-semibold', r.stream ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground')}>{r.stream ? 'stream' : 'sync'}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                      <span className="text-sky-700 dark:text-sky-400">↓{formatCompact(r.input_tokens, full)}</span> <span className="text-primary">↑{formatCompact(r.output_tokens, full)}</span>
                      {r.cached_tokens > 0 ? <span className="ml-1 text-muted-foreground">缓存 {formatCompact(r.cached_tokens, full)}</span> : null}
                      {r.reasoning_tokens > 0 ? <span className="ml-1 text-amber-700 dark:text-amber-400">推理 {formatCompact(r.reasoning_tokens, full)}</span> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{r.cost_usd > 0 ? `$${formatCost(r.cost_usd)}` : '—'}</TableCell>
                    <TableCell className={cn('text-right text-xs tabular-nums', (r.ttft_ms ?? 0) >= 5000 ? 'text-destructive' : (r.ttft_ms ?? 0) >= 2000 ? 'text-amber-600' : '')}>{r.ttft_ms != null ? formatMs(r.ttft_ms) : '—'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatMs(r.latency_ms)}</TableCell>
                    <TableCell className="max-w-[28ch] truncate text-xs text-muted-foreground" title={r.error ?? ''}>
                      {r.error || ''}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-xs text-muted-foreground">
                    没有符合条件的请求
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {data.total > PAGE ? <Pagination page={page} pageSize={PAGE} total={data.total} onPageChange={setPage} className="border-t border-border/70 px-4 py-3" /> : null}
        </div>
      )}
    </div>
  )
}
