import { useState } from 'react'
import { Copy, Plus } from 'lucide-react'

import { createKey, deleteKey, listKeys, updateKey, type ApiKey, type ApiKeyInput } from '@/api/pool'
import { InlineLoader } from '@/components/PageLoader'
import { FormField, FormSection } from '@/components/layout/FormScaffold'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { OnOff } from '@/components/pool/StatusBadge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useConfirm } from '@/components/ui/use-confirm'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { formatDateTime } from '@/lib/formatters'
import { useResource } from '@/lib/use-resource'

interface Draft {
  name: string
  max_concurrency: string
  rpm_limit: string
  enabled: boolean
}

const toDraft = (key: ApiKey | null): Draft => ({
  name: key?.name ?? '',
  max_concurrency: key?.max_concurrency == null ? '' : String(key.max_concurrency),
  rpm_limit: key?.rpm_limit == null ? '' : String(key.rpm_limit),
  enabled: key?.enabled ?? true,
})

const toInput = (draft: Draft): ApiKeyInput => {
  if (!draft.name.trim()) throw new Error('名称不能为空')
  return {
    name: draft.name.trim(),
    max_concurrency: draft.max_concurrency.trim() === '' ? null : Number(draft.max_concurrency),
    rpm_limit: draft.rpm_limit.trim() === '' ? null : Number(draft.rpm_limit),
    enabled: draft.enabled,
  }
}

export default function Keys() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const keys = useResource(() => listKeys(), [])
  const [editing, setEditing] = useState<{ key: ApiKey | null; draft: Draft } | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null)

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setFormError('')
    try {
      const input = toInput(editing.draft)
      if (editing.key) {
        await updateKey(editing.key.id, input)
        showToast('success', '已保存')
      } else {
        const created = await createKey(input)
        if (created.key) setRevealed({ name: created.name, secret: created.key })
      }
      setEditing(null)
      keys.refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (key: ApiKey) => {
    const ok = await confirm({
      title: `删除 key ${key.name}`,
      description: '使用它的调用方会立即收到 401。',
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await deleteKey(key.id)
      showToast('success', '已删除')
      keys.refresh()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '删除失败')
    }
  }

  const copySecret = async () => {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.secret)
      showToast('success', '已复制')
    } catch {
      showToast('error', '复制失败,请手动选择')
    }
  }

  const setDraft = (patch: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))

  const list = keys.data ?? []

  return (
    <PageShell
      title="API key"
      description="下游调用方用它访问网关。密钥只在创建时显示一次。"
      width="7xl"
      actions={
        <Button type="button" className="gap-2" onClick={() => { setFormError(''); setEditing({ key: null, draft: toDraft(null) }) }}>
          <Plus className="h-4 w-4" />
          新建 key
        </Button>
      }
    >
      {revealed ? (
        <PageSurface
          className="border-primary/40"
          title={`${revealed.name} 的密钥`}
          description="只显示这一次,请现在复制保存。"
          actions={
            <>
              <Button size="sm" variant="outline" className="gap-2" onClick={copySecret}>
                <Copy className="h-4 w-4" />
                复制
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>关闭</Button>
            </>
          }
        >
          <code className="block break-all rounded-lg bg-accent px-4 py-3 font-mono text-sm text-primary">{revealed.secret}</code>
        </PageSurface>
      ) : null}

      {keys.error ? (
        <PageSurface>
          <ErrorState message={keys.error} onRetry={keys.refresh} />
        </PageSurface>
      ) : !keys.data ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <PageSurface bodyClassName="p-0">
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>前缀</TableHead>
                  <TableHead className="text-right">并发</TableHead>
                  <TableHead className="text-right">RPM</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.length ? (
                  list.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell className="font-mono text-xs">{key.key_prefix}…</TableCell>
                      <TableCell className="text-right tabular-nums">{key.max_concurrency ?? '∞'}</TableCell>
                      <TableCell className="text-right tabular-nums">{key.rpm_limit ?? '∞'}</TableCell>
                      <TableCell><OnOff on={key.enabled} /></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {key.last_used_at ? formatDateTime(key.last_used_at) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => { setFormError(''); setEditing({ key, draft: toDraft(key) }) }}>编辑</Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => remove(key)}>删除</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <EmptyState title="还没有 key" description="创建一个给下游调用方。" />
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
            <DialogTitle>{editing?.key ? '编辑 API key' : '新建 API key'}</DialogTitle>
            <DialogDescription>并发和每分钟请求上限留空表示不限。</DialogDescription>
          </DialogHeader>
          {editing ? (
            <FormSection>
              <FormField label="名称" htmlFor="key-name" required>
                <Input id="key-name" value={editing.draft.name} onChange={(e) => setDraft({ name: e.target.value })} autoFocus />
              </FormField>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField label="最大并发" htmlFor="key-conc">
                  <Input id="key-conc" type="number" value={editing.draft.max_concurrency} onChange={(e) => setDraft({ max_concurrency: e.target.value })} />
                </FormField>
                <FormField label="每分钟请求上限" htmlFor="key-rpm">
                  <Input id="key-rpm" type="number" value={editing.draft.rpm_limit} onChange={(e) => setDraft({ rpm_limit: e.target.value })} />
                </FormField>
              </div>
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={editing.draft.enabled} onCheckedChange={(checked) => setDraft({ enabled: checked })} />
                启用
              </label>
              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            </FormSection>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>取消</Button>
            <Button onClick={save} disabled={saving}>{editing?.key ? '保存' : '创建'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
