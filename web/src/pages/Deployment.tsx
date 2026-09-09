import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeftRight, Box, History, RefreshCw, Rocket, RotateCcw, Undo2 } from 'lucide-react'

import {
  SLOTS,
  deployImage,
  getDeploymentStatus,
  getReleases,
  otherSlot,
  resumeOperation,
  rollRunner,
  rollbackTraffic,
  switchTraffic,
  type DeploymentStatus,
  type HistoryItem,
  type ReleaseInfo,
  type ReleasesStatus,
  type RunnerStatus,
  type Slot,
  type SlotContainer,
  type SlotStatus,
} from '@/api/deployment'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { formatDateTimeFull, relativeTime } from '@/lib/usage-format'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

/**
 * 部署页:安卓式 A/B 双槽。两个 manager 都常驻,只有活动槽接流量、跑后台任务;
 * 发布 = 新镜像装进备用槽 → 就绪 → 切流 → 旧槽按原版本重建成回滚点。
 * 所有变更先确认再提交,后台异步执行,页面 5 秒轮询;任何状态不完整都 fail-closed 禁用按钮。
 */

const STAGE_LABEL: Record<string, string> = {
  idle: '空闲',
  preparing: '准备备用槽',
  quiescing: '交接后台任务',
  cutover: '已切流,等待旧连接',
  retiring: '重建备用槽',
}
const KIND_LABEL: Record<string, string> = {
  deploy: '发布',
  switch: '切流',
  rollback: '回滚',
  runner: '滚动 runner',
  init: '初始化',
  resume: '继续操作',
}
const slotName = (s: Slot | null | undefined) => (s ? s.toUpperCase() : '未知')
const stageLabel = (s: string | undefined) => (s ? (STAGE_LABEL[s] ?? s) : '空闲')
const kindLabel = (k: string | undefined) => (k ? (KIND_LABEL[k] ?? k) : '—')
const fmtEpoch = (v: number | undefined | null) => (v ? formatDateTimeFull(new Date((v > 1e12 ? v : v * 1000)).toISOString()) : '—')
const fmtNum = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString())

function imageTag(image: string): string | null {
  const s = image.trim()
  const lastSlash = s.lastIndexOf('/')
  const lastColon = s.lastIndexOf(':')
  if (lastColon <= lastSlash) return null
  return s.slice(lastColon + 1) || null
}

/** 镜像必须用不可变标签:latest 会让备用槽记录的版本和实际内容对不上,回滚点失效。 */
function imageProblem(image: string): string | null {
  const s = image.trim()
  if (!s) return '请输入镜像'
  if (s.includes('@sha256:')) return null
  const tag = imageTag(s)
  if (!tag) return '缺少版本标签'
  if (['latest', 'main', 'master', 'edge', 'nightly', 'dev'].includes(tag.toLowerCase())) return `不要用可变标签 ${tag}`
  return null
}

function containerTone(c: SlotContainer): string {
  const health = (c.health ?? '').toLowerCase()
  const state = (c.state ?? '').toLowerCase()
  if (health === 'healthy' || (!health && state === 'running')) return 'bg-accent text-primary'
  if (health === 'starting' || state === 'created' || state === 'restarting') return 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
  return 'bg-destructive/10 text-destructive'
}

/** useResource 的静默轮询不暴露失败;这里记账:每次请求编号,最新一次失败写进 error(后端不可达时锁按钮)。 */
function useTracked<T>(load: () => Promise<T>) {
  const seqRef = useRef(0)
  const [completedSeq, setCompletedSeq] = useState(0)
  const [pollError, setPollError] = useState<string | null>(null)
  const fetcher = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const r = await load()
      if (seq === seqRef.current) setPollError(null)
      return r
    } catch (err) {
      if (seq === seqRef.current) setPollError(err instanceof Error ? err.message : '加载失败')
      throw err
    } finally {
      setCompletedSeq((p) => Math.max(p, seq))
    }
  }, [load])
  const { data, loading, error, refresh } = useResource(fetcher, [])
  const nextSeq = useCallback(() => seqRef.current + 1, [])
  return { data, loading, error: pollError ?? error, refresh, nextSeq, completedSeq }
}

function AlertBar({ tone, children }: { tone: 'error' | 'warn'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        tone === 'error' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  )
}

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 break-all text-sm', mono && 'font-mono text-xs')}>{children}</dd>
    </div>
  )
}

/** 禁用按钮上的 title 不会弹,把原因挂在外层。 */
function Gated({ reason, children }: { reason: string | null; children: ReactNode }) {
  return (
    <span className="inline-flex" title={reason ?? undefined}>
      {children}
    </span>
  )
}

function SlotCard({ slot, status, runtimeActive }: { slot: Slot; status: SlotStatus | undefined; runtimeActive: Slot | null }) {
  const isCurrent = runtimeActive === slot
  const mismatch = Boolean(status?.image && status?.runningImage && status.image !== status.runningImage)
  return (
    <PageSurface
      className={cn(isCurrent && 'ring-1 ring-primary/60')}
      title={`槽位 ${slotName(slot)}`}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {isCurrent ? <Badge>接流量</Badge> : runtimeActive ? <Badge variant="secondary">备用</Badge> : <Badge variant="outline">流量未知</Badge>}
          {status ? (
            <>
              {status.ready ? <Badge className="bg-accent text-primary">就绪</Badge> : <Badge variant="destructive">未就绪</Badge>}
              {status.leader ? <Badge className="bg-sky-600/15 text-sky-700 dark:text-sky-400">运行后台任务</Badge> : <Badge variant="outline" className="text-muted-foreground">后台任务未激活</Badge>}
            </>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">无状态</Badge>
          )}
        </div>
      }
    >
      {status ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="镜像" mono>{status.image || '—'}</Field>
            <Field label="实际运行镜像" mono>
              <span className={cn(mismatch && 'text-amber-700 dark:text-amber-400')}>{status.runningImage || '—'}</span>
              {mismatch ? <span className="ml-1 font-sans text-[11px] text-amber-700 dark:text-amber-400">(与记录不一致)</span> : null}
            </Field>
            <Field label="HAProxy 连接"><span className="tabular-nums">{fmtNum(status.connections)}</span></Field>
            <Field label="排队"><span className="tabular-nums">{fmtNum(status.queued)}</span></Field>
          </dl>
          <div>
            <div className="text-xs text-muted-foreground">容器</div>
            {status.containers.length ? (
              <ul className="mt-1 space-y-1">
                {status.containers.map((c) => (
                  <li key={c.name} className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-mono text-xs">{c.name}</span>
                    <Badge className={cn('px-1.5 py-0 text-[10px]', containerTone(c))}>{c.state || 'unknown'}</Badge>
                    {c.health ? <Badge className={cn('px-1.5 py-0 text-[10px]', containerTone(c))}>{c.health}</Badge> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">无容器</div>
            )}
          </div>
          {status.error ? <div className="text-sm text-destructive">{status.error}</div> : null}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">控制面未返回该槽位状态。</div>
      )}
    </PageSurface>
  )
}

function RunnerCard({ runner }: { runner: RunnerStatus | undefined }) {
  const mismatch = Boolean(runner?.image && runner?.runningImage && runner.image !== runner.runningImage)
  return (
    <PageSurface title="Runner" description="托管 codexs 实例的容器,不分槽单独滚动;滚动时实例重启一次,由后台任务在下一个健康周期拉回。">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
        <Field label="镜像" mono>{runner?.image || '—'}</Field>
        <Field label="实际运行镜像" mono>
          <span className={cn(mismatch && 'text-amber-700 dark:text-amber-400')}>{runner?.runningImage || '—'}</span>
        </Field>
        <Field label="状态">{runner?.state || '—'}</Field>
        <Field label="健康">{runner?.health || '—'}</Field>
      </dl>
    </PageSurface>
  )
}

function ReleaseSummary({ title, release, sha, badge, extra, actions }: { title: string; release: ReleaseInfo | null | undefined; sha: string | null | undefined; badge?: ReactNode; extra?: ReactNode; actions?: ReactNode }) {
  const shown = release?.sha ?? sha ?? null
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/80 bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{title}</div>
        {badge}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={cn('font-mono text-lg font-semibold', !shown && 'text-muted-foreground')}>{shown ?? '—'}</span>
        {release?.createdAt ? (
          <span className="text-xs text-muted-foreground" title={formatDateTimeFull(release.createdAt)}>
            构建于 {relativeTime(release.createdAt)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 text-sm">
        {release ? (
          release.message ? (
            <span className="break-words" title={release.author ? `${release.author}:${release.message}` : release.message}>{release.message}</span>
          ) : (
            <span className="text-muted-foreground">镜像未带提交说明</span>
          )
        ) : shown ? (
          <span className="text-muted-foreground">不在最近版本列表中</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
      {extra}
      {actions ? <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
    </div>
  )
}

type Pending =
  | { kind: 'deploy'; image: string; sha: string | null; standby: Slot | null; active: Slot | null }
  | { kind: 'switch'; target: Slot; expectedActive: Slot }
  | { kind: 'rollback'; target: Slot; expectedActive: Slot; standbyImage: string | null | undefined }
  | { kind: 'resume' }
  | { kind: 'runner'; image: string; sha: string | null }

export default function Deployment() {
  const { showToast } = useGlobalToast()
  const { data: status, loading, error: fetchError, refresh, nextSeq, completedSeq } = useTracked<DeploymentStatus>(getDeploymentStatus)

  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 5000)
    return () => window.clearInterval(t)
  }, [refresh])

  const forceRef = useRef(false)
  const loadReleases = useCallback(() => {
    const force = forceRef.current
    forceRef.current = false
    return getReleases(force)
  }, [])
  const { data: releases, loading: releasesLoading, error: releasesError, refresh: refreshReleases } = useTracked<ReleasesStatus>(loadReleases)
  const enabled = status?.enabled ?? false
  useEffect(() => {
    if (!enabled) return
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshReleases()
    }, 60_000)
    return () => window.clearInterval(t)
  }, [enabled, refreshReleases])
  const checkReleases = () => {
    forceRef.current = true
    refreshReleases()
  }

  const awaitSeq = useRef<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [deployInput, setDeployInput] = useState('')
  const [runnerInput, setRunnerInput] = useState('')
  useEffect(() => {
    if (uncertain && awaitSeq.current !== null && completedSeq >= awaitSeq.current) {
      awaitSeq.current = null
      setUncertain(false)
    }
  }, [completedSeq, uncertain])

  const busy = status?.busy ?? false
  const stage = status?.operation?.stage ?? 'idle'
  const active = status?.active ?? null
  const runtimeActive = status?.runtimeActive ?? null
  const runtimeMismatch = Boolean(runtimeActive && active && runtimeActive !== active)
  const currentSlot: Slot | null = runtimeActive ?? active
  const standbySlot: Slot | null = currentSlot ? otherSlot(currentSlot) : null

  const wasIdle = useRef<boolean | null>(null)
  useEffect(() => {
    const idleNow = enabled && stage === 'idle' && !busy
    if (wasIdle.current === false && idleNow) refreshReleases()
    wasIdle.current = idleNow
  }, [enabled, stage, busy, refreshReleases])

  const globalBlock = useMemo<string | null>(() => {
    if (!status) return '状态未加载'
    if (!enabled) return '未启用 A/B 控制服务'
    if (status.error) return `控制面状态不完整:${status.error}`
    if (fetchError) return '状态刷新失败,保留上次快照'
    if (submitting) return '请求提交中'
    if (busy) return '后台任务进行中'
    if (stage !== 'idle') return `操作未完成(${stageLabel(stage)})`
    if (runtimeMismatch) return 'HAProxy 实际目标与记录不一致'
    if (uncertain) return '等待状态刷新确认上一次操作'
    return null
  }, [status, enabled, fetchError, submitting, busy, stage, runtimeMismatch, uncertain])

  const resumeBlock = useMemo<string | null>(() => {
    if (!status) return '状态未加载'
    if (!enabled) return '未启用 A/B 控制服务'
    if (status.error) return `控制面状态不完整:${status.error}`
    if (fetchError) return '状态刷新失败'
    if (submitting) return '请求提交中'
    if (busy) return '后台任务正在运行,无需继续'
    if (uncertain) return '等待状态刷新'
    if (stage === 'idle') return '没有未完成的操作'
    return null
  }, [status, enabled, fetchError, submitting, busy, uncertain, stage])

  const switchBlock = useCallback(
    (target: Slot): string | null => {
      if (globalBlock) return globalBlock
      if (!currentSlot) return '当前流量目标未知'
      if (target === currentSlot) return `槽位 ${slotName(target)} 已在接流量`
      const s = status?.slots?.[target]
      if (!s) return `槽位 ${slotName(target)} 无状态`
      if (s.role !== 'standby') return `槽位 ${slotName(target)} 不是备用槽`
      if (!s.ready) return `槽位 ${slotName(target)} 未就绪`
      if ((s.connections ?? 0) > 0) return `槽位 ${slotName(target)} 仍有 ${s.connections} 个连接`
      return null
    },
    [globalBlock, currentSlot, status],
  )
  const deployTagProblem = imageProblem(deployInput)
  const deployBlock = globalBlock ?? deployTagProblem
  const runnerTagProblem = imageProblem(runnerInput)
  const runnerBlock = globalBlock ?? runnerTagProblem
  const rollbackBlock = standbySlot ? switchBlock(standbySlot) : (globalBlock ?? '当前流量目标未知')

  const running = releases?.running
  const latest = releases?.latest ?? null
  const updateAvailable = releases?.updateAvailable ?? false
  const activeRelease = useMemo(() => (running?.active ? (releases?.releases.find((r) => r.sha === running.active) ?? null) : null), [releases, running])
  const recent = useMemo(() => releases?.releases.slice(0, 10) ?? [], [releases])

  const runnerDirty = useRef(false)
  const runnerImage = status?.runner?.image
  useEffect(() => {
    if (runnerDirty.current) return
    const candidate = latest?.image ?? (runnerImage && !imageProblem(runnerImage) ? runnerImage : '')
    if (candidate) setRunnerInput(candidate)
  }, [latest, runnerImage])

  const deployReleaseBlock = useCallback(
    (r: ReleaseInfo): string | null => {
      if (globalBlock) return globalBlock
      if (running?.active && r.sha === running.active) return `版本 ${r.sha} 已是活动版本`
      return imageProblem(r.image)
    },
    [globalBlock, running],
  )
  const runnerReleaseBlock = useCallback(
    (r: ReleaseInfo): string | null => {
      if (globalBlock) return globalBlock
      if (running?.runner && r.sha === running.runner) return `runner 已运行版本 ${r.sha}`
      return imageProblem(r.image)
    },
    [globalBlock, running],
  )
  const deployLatestBlock = !latest ? '暂无可用版本' : !updateAvailable ? '已是最新版本' : deployReleaseBlock(latest)
  const runnerLatestBlock = !latest ? '暂无可用版本' : runnerReleaseBlock(latest)

  const history = useMemo<HistoryItem[]>(() => [...(status?.history ?? [])].reverse(), [status])

  const runMutation = useCallback(
    async (label: string, call: () => Promise<unknown>) => {
      setSubmitting(true)
      setDialogError(null)
      let ok = false
      try {
        await call()
        ok = true
      } catch (err) {
        const message = err instanceof Error ? err.message : '请求失败'
        setDialogError(`${label}失败:${message}`)
        showToast('error', `${label}失败:${message}`)
      } finally {
        setSubmitting(false)
        awaitSeq.current = nextSeq()
        setUncertain(true)
        refresh()
      }
      if (ok) {
        showToast('success', '已受理,状态会自动刷新')
        setPending(null)
        refreshReleases()
      }
    },
    [refresh, refreshReleases, nextSeq, showToast],
  )

  const openDeploy = (image: string, sha: string | null) => {
    setDialogError(null)
    setPending({ kind: 'deploy', image: image.trim(), sha, standby: standbySlot, active: currentSlot })
  }
  const openRunner = (image: string, sha: string | null) => {
    setDialogError(null)
    setPending({ kind: 'runner', image: image.trim(), sha })
  }
  const confirmPending = () => {
    if (!pending) return
    switch (pending.kind) {
      case 'deploy':
        void runMutation('发布', () => deployImage(pending.image))
        break
      case 'switch':
        void runMutation('切流', () => switchTraffic(pending.target, pending.expectedActive))
        break
      case 'rollback':
        void runMutation('回滚', () => rollbackTraffic(pending.expectedActive))
        break
      case 'resume':
        void runMutation('继续操作', () => resumeOperation())
        break
      case 'runner':
        void runMutation('滚动 runner', () => rollRunner(pending.image))
        break
    }
  }
  const pendingProblem = pending && (pending.kind === 'deploy' || pending.kind === 'runner') ? imageProblem(pending.image) : null
  const confirmDisabled = !pending || submitting || Boolean(pendingProblem) || (pending.kind === 'resume' ? resumeBlock !== null : globalBlock !== null)

  const shell = {
    title: '部署',
    description: 'A/B 双槽发布:新版本先装进备用槽,就绪后一键切流;旧槽保留上一版本,随时秒级回滚。',
    width: '7xl' as const,
    actions: (
      <Button variant="outline" size="sm" className="gap-2" onClick={() => refresh()}>
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        刷新
      </Button>
    ),
  }

  if (loading && !status) {
    return (
      <PageShell {...shell}>
        <PageSurface>
          <div className="flex items-center justify-center py-16">
            <InlineLoader />
          </div>
        </PageSurface>
      </PageShell>
    )
  }
  if (!status) {
    return (
      <PageShell {...shell}>
        <AlertBar tone="error">状态加载失败:{fetchError ?? '未知错误'}</AlertBar>
      </PageShell>
    )
  }
  if (!status.enabled) {
    return (
      <PageShell {...shell}>
        <PageSurface>
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Rocket className="h-8 w-8 opacity-40" />
            <p>当前部署未启用 A/B 控制服务</p>
            <p className="text-xs">在 .env 里设置 PM_DEPLOY_TOKEN 并启动 deployment 服务后,这里会显示两个槽位。</p>
          </div>
        </PageSurface>
      </PageShell>
    )
  }

  const op = status.operation
  const releasesUnavailable = !releases && Boolean(releasesError)

  return (
    <PageShell {...shell}>
      <div className="space-y-4">
        <PageSurface bodyClassName="px-5 py-4">
          <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="text-sm">
              实际接流量:
              <span className={cn('ml-1 font-semibold', runtimeActive ? 'text-foreground' : 'text-muted-foreground')}>槽位 {slotName(runtimeActive)}</span>
              {active && runtimeActive !== active ? <span className="ml-2 text-xs text-muted-foreground">记录:槽位 {slotName(active)}</span> : null}
              {status.redisActive ? <span className="ml-2 text-xs text-muted-foreground">后台任务归属:槽位 {slotName(status.redisActive as Slot)}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={stage === 'idle' ? 'outline' : 'default'}>{stageLabel(stage)}</Badge>
              {busy ? <Badge variant="destructive">操作中</Badge> : null}
              {stage !== 'idle' && op?.kind ? <Badge variant="outline">{kindLabel(op.kind)}</Badge> : null}
              {stage !== 'idle' && op?.candidate ? <Badge variant="outline">候选槽 {slotName(op.candidate)}</Badge> : null}
            </div>
            {stage !== 'idle' && op ? (
              <div className="w-full text-xs text-muted-foreground md:ml-auto md:w-auto">
                {op.image ? <span className="mr-3 font-mono">{op.image}</span> : null}
                <span>开始 {fmtEpoch(op.startedAt)}</span>
                <span className="ml-3">更新 {fmtEpoch(op.updatedAt)}</span>
              </div>
            ) : null}
          </div>
        </PageSurface>

        {fetchError ? <AlertBar tone="error">状态刷新失败:{fetchError},保留上次快照,所有变更已禁用</AlertBar> : null}
        {runtimeMismatch ? <AlertBar tone="warn">HAProxy 实际目标(槽 {slotName(runtimeActive)})与记录(槽 {slotName(active)})不一致,禁止操作</AlertBar> : null}
        {status.error ? <AlertBar tone="error">控制面状态不完整:{status.error},所有变更已禁用</AlertBar> : null}
        {status.lastError ? <AlertBar tone="warn">上次后台任务错误:{status.lastError}</AlertBar> : null}
        {op?.error ? <AlertBar tone="warn">当前操作错误:{op.error}</AlertBar> : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {SLOTS.map((slot) => (
            <SlotCard key={slot} slot={slot} status={status.slots?.[slot]} runtimeActive={runtimeActive} />
          ))}
        </div>

        <RunnerCard runner={status.runner} />

        <PageSurface
          title="版本"
          description={`自动检测 ghcr.io 上 CI 构建的 sha-<sha> 镜像,按构建时间排序。${releases?.checkedAt ? `上次检测 ${relativeTime(new Date(releases.checkedAt * 1000).toISOString())}。` : ''}`}
          actions={
            <Button variant="outline" size="sm" className="gap-2" onClick={checkReleases} disabled={releasesLoading}>
              <RefreshCw className={cn('h-4 w-4', releasesLoading && 'animate-spin')} />
              检查更新
            </Button>
          }
        >
          <div className="space-y-4">
            {releasesError ? <div className="text-sm text-amber-700 dark:text-amber-400">版本检测失败:{releasesError}{releases ? ',显示上次结果' : ''}</div> : null}
            {releases?.error ? <div className="text-sm text-amber-700 dark:text-amber-400">版本检测异常:{releases.error}{releases.releases.length ? ',显示上次结果' : ''}</div> : null}
            {!releases && releasesLoading ? (
              <div className="flex items-center justify-center py-8">
                <InlineLoader />
              </div>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2">
                  <ReleaseSummary
                    title="当前活动版本"
                    release={activeRelease}
                    sha={running?.active}
                    badge={currentSlot ? <Badge variant="outline">运行于槽位 {slotName(currentSlot)}</Badge> : <Badge variant="outline">位置未知</Badge>}
                    extra={
                      running ? (
                        <div className="flex flex-wrap gap-2 font-mono text-xs text-muted-foreground">
                          {SLOTS.map((s) => (
                            <span key={s}>
                              槽 {slotName(s)}:{running[s] || '—'}
                            </span>
                          ))}
                          <span>runner:{running.runner || '—'}</span>
                        </div>
                      ) : null
                    }
                  />
                  <ReleaseSummary
                    title="最新可用版本"
                    release={latest}
                    sha={latest?.sha}
                    badge={releasesUnavailable ? <Badge variant="destructive">检测失败</Badge> : !latest ? <Badge variant="outline">暂无版本</Badge> : updateAvailable ? <Badge>有新版本</Badge> : <Badge variant="secondary">已是最新</Badge>}
                    extra={
                      latest && latest.runningIn.length ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">已运行于</span>
                          {latest.runningIn.map((loc) => (
                            <Badge key={loc} variant="secondary" className="px-1.5 py-0 text-[10px]">
                              {loc === 'runner' ? 'runner' : `槽 ${slotName(loc)}`}
                            </Badge>
                          ))}
                        </div>
                      ) : null
                    }
                    actions={
                      <>
                        <Gated reason={deployLatestBlock}>
                          <Button size="sm" className="gap-2" disabled={deployLatestBlock !== null} onClick={() => latest && openDeploy(latest.image, latest.sha)}>
                            <Rocket className="h-4 w-4" />
                            发布最新版本
                          </Button>
                        </Gated>
                        <Gated reason={runnerLatestBlock}>
                          <Button variant="outline" size="sm" className="gap-2" disabled={runnerLatestBlock !== null} onClick={() => latest && openRunner(latest.image, latest.sha)}>
                            <RotateCcw className="h-4 w-4" />
                            runner 滚到最新
                          </Button>
                        </Gated>
                      </>
                    }
                  />
                </div>

                <div>
                  <div className="mb-2 text-sm font-medium">最近版本</div>
                  {recent.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">{releasesUnavailable ? '版本检测失败,暂无数据' : '没有检测到可用版本'}</div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-border/80">
                      <table className="w-full min-w-[760px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">版本</th>
                            <th className="px-3 py-2 font-medium">构建时间</th>
                            <th className="px-3 py-2 font-medium">提交说明</th>
                            <th className="px-3 py-2 font-medium">运行位置</th>
                            <th className="px-3 py-2 text-right font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recent.map((r) => {
                            const dReason = deployReleaseBlock(r)
                            const rReason = runnerReleaseBlock(r)
                            const isCurrent = Boolean(runtimeActive && r.runningIn.includes(runtimeActive))
                            return (
                              <tr key={r.sha} className="border-b last:border-0 hover:bg-muted/30">
                                <td className="px-3 py-2 font-mono text-xs" title={r.fullSha ?? undefined}>{r.sha}</td>
                                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={r.createdAt ? formatDateTimeFull(r.createdAt) : ''}>{r.createdAt ? relativeTime(r.createdAt) : '—'}</td>
                                <td className="max-w-[320px] truncate px-3 py-2" title={r.message ?? undefined}>
                                  {r.message || <span className="text-muted-foreground">—</span>}
                                  {r.author ? <span className="ml-1 text-xs text-muted-foreground">· {r.author}</span> : null}
                                </td>
                                <td className="px-3 py-2">
                                  {r.runningIn.length ? (
                                    <div className="flex flex-wrap items-center gap-1">
                                      {isCurrent ? <Badge className="px-1.5 py-0 text-[10px]">当前</Badge> : null}
                                      {r.runningIn.map((loc) => (
                                        <Badge key={loc} variant={loc === 'runner' ? 'outline' : 'secondary'} className="px-1.5 py-0 text-[10px]">
                                          {loc === 'runner' ? 'runner' : `槽 ${slotName(loc)}`}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex items-center justify-end gap-1">
                                    <Gated reason={dReason}>
                                      <Button variant="outline" size="sm" disabled={dReason !== null} onClick={() => openDeploy(r.image, r.sha)}>发布此版本</Button>
                                    </Gated>
                                    <Gated reason={rReason}>
                                      <Button variant="ghost" size="sm" disabled={rReason !== null} onClick={() => openRunner(r.image, r.sha)}>runner 用此版本</Button>
                                    </Gated>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </PageSurface>

        <PageSurface title="发布与切流" description="每个操作都会先弹出确认;受理后后台异步执行,页面每 5 秒自动刷新。">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {SLOTS.map((slot) => {
                const reason = switchBlock(slot)
                return (
                  <Gated key={slot} reason={reason}>
                    <Button variant="outline" className="gap-2" disabled={reason !== null} onClick={() => currentSlot && setPending({ kind: 'switch', target: slot, expectedActive: currentSlot })}>
                      <ArrowLeftRight className="h-4 w-4" />
                      安全切到 {slotName(slot)}
                    </Button>
                  </Gated>
                )
              })}
              <Gated reason={rollbackBlock}>
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={rollbackBlock !== null}
                  onClick={() => currentSlot && standbySlot && setPending({ kind: 'rollback', target: standbySlot, expectedActive: currentSlot, standbyImage: status.slots?.[standbySlot]?.image })}
                >
                  <Undo2 className="h-4 w-4" />
                  回滚到备用槽{standbySlot ? ` ${slotName(standbySlot)}` : ''}
                </Button>
              </Gated>
              {stage !== 'idle' ? (
                <Gated reason={resumeBlock}>
                  <Button variant="secondary" className="gap-2" disabled={resumeBlock !== null} onClick={() => setPending({ kind: 'resume' })}>
                    <RotateCcw className="h-4 w-4" />
                    继续未完成操作
                  </Button>
                </Gated>
              ) : null}
            </div>

            <details className="rounded-xl border border-border/80">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">手动指定镜像</summary>
              <div className="space-y-5 border-t border-border/80 px-3 py-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="deploy-image">发布新版本到备用槽</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input id="deploy-image" className="font-mono text-xs" placeholder="ghcr.io/meglinge/codexs-poolmanager:sha-<sha>" value={deployInput} onChange={(e) => setDeployInput(e.target.value)} spellCheck={false} />
                    <Gated reason={deployBlock}>
                      <Button className="gap-2" disabled={deployBlock !== null} onClick={() => openDeploy(deployInput, null)}>
                        <Rocket className="h-4 w-4" />
                        发布
                      </Button>
                    </Gated>
                  </div>
                  <p className={cn('text-xs', deployInput.trim() && deployTagProblem ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                    请用不可变标签(sha-&lt;sha&gt; / vX.Y.Z / @sha256),不要用 latest{deployInput.trim() && deployTagProblem ? `(${deployTagProblem})` : ''}
                    {standbySlot ? ` · 将装进备用槽 ${slotName(standbySlot)}` : ''}
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="runner-image">滚动 runner</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="runner-image"
                      className="font-mono text-xs"
                      placeholder="ghcr.io/meglinge/codexs-poolmanager:sha-<sha>"
                      value={runnerInput}
                      onChange={(e) => {
                        runnerDirty.current = true
                        setRunnerInput(e.target.value)
                      }}
                      spellCheck={false}
                    />
                    <Gated reason={runnerBlock}>
                      <Button variant="outline" className="gap-2" disabled={runnerBlock !== null} onClick={() => openRunner(runnerInput, null)}>
                        <RotateCcw className="h-4 w-4" />
                        滚动 runner
                      </Button>
                    </Gated>
                  </div>
                  <p className={cn('text-xs', runnerInput.trim() && runnerTagProblem ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                    runner 滚动时它托管的实例会重启一次{runnerInput.trim() && runnerTagProblem ? `(${runnerTagProblem})` : ''}
                  </p>
                </div>
              </div>
            </details>
          </div>
        </PageSurface>

        <PageSurface title="操作历史" bodyClassName="p-0">
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <History className="h-8 w-8 opacity-40" />
              <p>暂无操作记录</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">时间</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                    <th className="px-4 py-3 font-medium">从 → 到</th>
                    <th className="px-4 py-3 font-medium">镜像</th>
                    <th className="px-4 py-3 font-medium">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={`${h.at}-${h.kind}-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{h.at}</td>
                      <td className="px-4 py-3">{kindLabel(h.kind)}</td>
                      <td className="px-4 py-3">{h.from || h.to ? <span className="uppercase">{h.from || '—'} → {h.to || '—'}</span> : '—'}</td>
                      <td className="max-w-[320px] truncate px-4 py-3 font-mono text-xs" title={h.image}>{h.image || '—'}</td>
                      <td className="px-4 py-3">
                        {h.ok ? (
                          <Badge className="bg-accent text-primary">成功</Badge>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="destructive">失败</Badge>
                            {h.error ? <span className="text-xs text-destructive">{h.error}</span> : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PageSurface>
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          {pending?.kind === 'deploy' ? (
            <>
              <DialogHeader>
                <DialogTitle>{pending.sha ? `发布版本 ${pending.sha}` : '发布新版本'}</DialogTitle>
                <DialogDescription>确认后立即开始,后台异步执行,期间所有变更按钮禁用。</DialogDescription>
              </DialogHeader>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                <li>
                  备用槽 <strong>{slotName(pending.standby)}</strong> 装入镜像 <span className="break-all font-mono text-xs">{pending.image}</span>
                </li>
                <li>备用槽就绪后交接后台任务,再把新请求切过去</li>
                <li>
                  旧槽 <strong>{slotName(pending.active)}</strong> 等在飞的流式响应结束后,按当前版本{running?.active ? <>(<span className="font-mono">{running.active}</span>)</> : null}重建为备用,作为回滚点
                </li>
              </ol>
            </>
          ) : null}
          {pending?.kind === 'switch' ? (
            <>
              <DialogHeader>
                <DialogTitle>安全切到槽位 {slotName(pending.target)}</DialogTitle>
                <DialogDescription>纯流量切换,两槽版本都不变。</DialogDescription>
              </DialogHeader>
              <p className="text-sm">
                新请求目标:<strong>{slotName(pending.expectedActive)}</strong> → <strong>{slotName(pending.target)}</strong>。旧槽上的连接会自然结束。
              </p>
            </>
          ) : null}
          {pending?.kind === 'rollback' ? (
            <>
              <DialogHeader>
                <DialogTitle>回滚到备用槽 {slotName(pending.target)}</DialogTitle>
                <DialogDescription>把新请求切回备用槽,它上面保留的是上一版本。</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5 text-sm">
                <p>
                  新请求目标:<strong>{slotName(pending.expectedActive)}</strong> → <strong>{slotName(pending.target)}</strong>
                </p>
                <p>
                  备用槽镜像:<span className="ml-1 break-all font-mono text-xs">{pending.standbyImage || '(未知)'}</span>
                </p>
              </div>
            </>
          ) : null}
          {pending?.kind === 'resume' ? (
            <>
              <DialogHeader>
                <DialogTitle>继续未完成操作</DialogTitle>
                <DialogDescription>让控制面从上次中断的阶段接着执行。</DialogDescription>
              </DialogHeader>
              <p className="text-sm">
                当前阶段:<strong>{stageLabel(stage)}</strong>
                {op?.kind ? <span className="ml-2 text-muted-foreground">({kindLabel(op.kind)})</span> : null}
              </p>
            </>
          ) : null}
          {pending?.kind === 'runner' ? (
            <>
              <DialogHeader>
                <DialogTitle>{pending.sha ? `runner 滚到版本 ${pending.sha}` : '滚动 runner'}</DialogTitle>
                <DialogDescription>重建 runner 容器;它托管的 codexs 实例会重启一次,由后台任务在下一个健康周期拉回。</DialogDescription>
              </DialogHeader>
              <p className="text-sm">
                镜像:<span className="ml-1 break-all font-mono text-xs">{pending.image}</span>
              </p>
            </>
          ) : null}
          {pendingProblem ? <AlertBar tone="error">镜像不合规,已阻止提交:{pendingProblem}</AlertBar> : null}
          {dialogError ? <div className="text-sm text-destructive">{dialogError}</div> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={submitting}>取消</Button>
            <Button variant={pending?.kind === 'rollback' ? 'destructive' : 'default'} onClick={confirmPending} disabled={confirmDisabled}>
              {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}
              确认执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
