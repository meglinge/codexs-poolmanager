import { STATUS_LABEL, type AccountStatus } from '@/api/pool'
import { cn } from '@/lib/utils'

/** 账号状态:一个色点 + 文字。颜色只编码状态:薄荷 = 运行中,琥珀 = 过渡/异常,红 = 失败。 */
export function StatusBadge({ status, className }: { status: AccountStatus; className?: string }) {
  const dot =
    status === 'running'
      ? 'bg-primary'
      : status === 'starting' || status === 'unhealthy'
        ? 'bg-amber-500'
        : status === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground/60'
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium', className)}>
      <span className={cn('pm-dot', dot, status === 'starting' && 'status-pulse')} />
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function OnOff({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold',
        on ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      {on ? '启用' : '停用'}
    </span>
  )
}
