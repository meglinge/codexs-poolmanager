import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'

import { deleteRunner, listRunners, upsertRunner, type Runner, type RunnerInput } from '@/api/pool'
import { InlineLoader } from '@/components/PageLoader'
import { FormField, FormSection } from '@/components/layout/FormScaffold'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useConfirm } from '@/components/ui/use-confirm'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

const toDraft = (runner: Runner | null): RunnerInput => ({
  id: runner?.id ?? 'runner',
  name: runner?.name ?? '',
  base_url: runner?.base_url ?? 'http://runner:7000',
  public_host: runner?.public_host ?? 'runner',
  token: '',
})

export default function Runners() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const runners = useResource(() => listRunners(), [])
  const [editing, setEditing] = useState<{ runner: Runner | null; draft: RunnerInput } | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const save = async () => {
    if (!editing) return
    const d = editing.draft
    setFormError('')
    if (!/^[A-Za-z0-9_-]+$/.test(d.id)) return setFormError('ID 只能包含字母、数字、- 和 _')
    if (!d.name.trim() || !d.base_url.trim() || !d.public_host.trim()) return setFormError('名称、控制地址、实例主机都不能为空')
    if (!d.token) return setFormError(editing.runner ? '编辑时需要重新输入 token' : '需要 runner token')
    setSaving(true)
    try {
      await upsertRunner({ ...d, name: d.name.trim(), base_url: d.base_url.trim(), public_host: d.public_host.trim() })
      showToast('success', '已保存')
      setEditing(null)
      runners.refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (runner: Runner) => {
    const ok = await confirm({
      title: `删除 runner ${runner.id}`,
      description: '它下面的账号需要先删除。',
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await deleteRunner(runner.id)
      showToast('success', '已删除')
      runners.refresh()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '删除失败')
    }
  }

  const setDraft = (patch: Partial<RunnerInput>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))

  const list = runners.data ?? []

  return (
    <PageShell
      title="Runner"
      description="托管 codexs 进程的主机。manager 通过控制地址启停实例,通过实例主机转发请求。"
      width="7xl"
      actions={
        <>
          <Button type="button" variant="outline" className="gap-2" onClick={runners.refresh} disabled={runners.loading}>
            <RefreshCw className={cn('h-4 w-4', runners.loading && 'animate-spin')} />
            刷新
          </Button>
          <Button type="button" className="gap-2" onClick={() => { setFormError(''); setEditing({ runner: null, draft: toDraft(null) }) }}>
            <Plus className="h-4 w-4" />
            添加 runner
          </Button>
        </>
      }
    >
      {runners.error ? (
        <PageSurface>
          <ErrorState message={runners.error} onRetry={runners.refresh} />
        </PageSurface>
      ) : !runners.data ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <PageSurface bodyClassName="p-0">
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>控制地址</TableHead>
                  <TableHead>实例主机</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">实例数</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.length ? (
                  list.map((runner) => (
                    <TableRow key={runner.id}>
                      <TableCell className="font-mono text-xs">{runner.id}</TableCell>
                      <TableCell className="font-medium">{runner.name}</TableCell>
                      <TableCell className="font-mono text-xs">{runner.base_url}</TableCell>
                      <TableCell className="font-mono text-xs">{runner.public_host}</TableCell>
                      <TableCell>
                        <span className={cn('inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium')}>
                          <span className={cn('pm-dot', runner.online ? 'bg-primary' : 'bg-destructive')} />
                          {runner.online ? '在线' : '离线'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{runner.instances ?? '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{runner.runner_version || '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => { setFormError(''); setEditing({ runner, draft: toDraft(runner) }) }}>编辑</Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => remove(runner)}>删除</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <EmptyState title="还没有 runner" description="compose 部署时添加 http://runner:7000,token 填 PM_RUNNER_TOKEN。" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </PageSurface>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => (!open ? setEditing(null) : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.runner ? '编辑 runner' : '添加 runner'}</DialogTitle>
            <DialogDescription>token 不会回显,保存时需要填写。</DialogDescription>
          </DialogHeader>
          {editing ? (
            <FormSection>
              <FormField label="ID" htmlFor="runner-id" description="字母、数字、- 和 _" required>
                <Input id="runner-id" value={editing.draft.id} disabled={Boolean(editing.runner)} onChange={(e) => setDraft({ id: e.target.value })} />
              </FormField>
              <FormField label="名称" htmlFor="runner-name" required>
                <Input id="runner-name" value={editing.draft.name} onChange={(e) => setDraft({ name: e.target.value })} />
              </FormField>
              <FormField label="控制地址" htmlFor="runner-url" description="manager 访问 runner 的 URL" required>
                <Input id="runner-url" value={editing.draft.base_url} onChange={(e) => setDraft({ base_url: e.target.value })} />
              </FormField>
              <FormField label="实例主机" htmlFor="runner-host" description="manager 访问 codexs 实例用的主机名" required>
                <Input id="runner-host" value={editing.draft.public_host} onChange={(e) => setDraft({ public_host: e.target.value })} />
              </FormField>
              <FormField label="Runner token" htmlFor="runner-token" description="PM_RUNNER_TOKEN" required>
                <Input id="runner-token" type="password" value={editing.draft.token} onChange={(e) => setDraft({ token: e.target.value })} />
              </FormField>
              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            </FormSection>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>取消</Button>
            <Button onClick={save} disabled={saving}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
