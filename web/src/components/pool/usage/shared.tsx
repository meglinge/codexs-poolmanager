import type { ElementType, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** 面板各页签共用的小积木(纯组件;常量与格式化在 lib.ts)。 */

export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-border/80 bg-background p-4', className)}>
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title ? <h4 className="text-sm font-semibold">{title}</h4> : null}
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function CompactMetric({ icon: Icon, label, value, detail }: { icon: ElementType; label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/80 bg-background px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

export function SignalCard({ icon: Icon, title, rows, children }: { icon: ElementType; title: string; rows?: Array<{ label: string; value: ReactNode }>; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/80 bg-background p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      {rows ? (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-semibold tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  )
}

export function HighlightStrip({ label, value, detail }: { label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/80 bg-background p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-lg font-semibold">{value}</p>
      <p className="mt-1 truncate text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}

export function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/80 bg-background p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

export function PillGroup<T extends string>({ value, onChange, options, size = 'sm' }: { value: T; onChange: (v: T) => void; options: Array<{ key: T; label: string }>; size?: 'sm' | 'xs' }) {
  return (
    <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded-md font-semibold transition-colors',
            size === 'sm' ? 'h-7 min-w-12 px-2.5 text-xs' : 'h-6 min-w-10 px-2 text-[11px]',
            value === o.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'error' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg px-3 py-2 text-xs',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'warn' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        tone === 'info' && 'bg-accent text-primary',
      )}
    >
      {children}
    </div>
  )
}
