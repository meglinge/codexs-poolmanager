import { useState } from 'react'
import { MoreHorizontal, Plus, RefreshCw } from 'lucide-react'

import {
  accountAction,
  createAccount,
  deleteAccount,
  getAccountLogs,
  listAccounts,
  listRunners,
  updateAccount,
  type Account,
  type AccountInput,
} from '@/api/pool'
import { InlineLoader } from '@/components/PageLoader'
import { FormField, FormSection } from '@/components/layout/FormScaffold'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { OnOff, StatusBadge } from '@/components/pool/StatusBadge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/components/ui/use-confirm'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

interface Draft {
  name: string
  runner_id: string
  port: string
  proxy_url: string
  max_concurrency: string
  rpm_limit: string
  auth_json: string
  enabled: boolean
}

function nextPort(accounts: Account[]): number {
  const used = new Set(accounts.map((a) => a.port))
  let port = 8790
  while (used.has(port)) port += 1
  return port
}

function toDraft(account: Account | null, accounts: Account[], defaultRunner: string): Draft {
  return {
    name: account?.name ?? '',
    runner_id: account?.runner_id ?? defaultRunner,
    port: String(account?.port ?? nextPort(accounts)),
    proxy_url: account?.proxy_url ?? '',
    max_concurrency: String(account?.max_concurrency ?? 4),
    rpm_limit: account?.rpm_limit == null ? '' : String(account.rpm_limit),
    auth_json: '',
    enabled: account?.enabled ?? true,
  }
}

function toInput(draft: Draft, creating: boolean): AccountInput {
  let auth: unknown | null = null
  if (draft.auth_json.trim()) {
    try {
      auth = JSON.parse(draft.auth_json)
    } catch {
      throw new Error('auth.json 不是合法 JSON')
    }
  }
  if (creating && !auth) throw new Error('需要 auth.json')
  if (!draft.name.trim()) throw new Error('名称不能为空')
  const port = Number(draft.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1-65535 之间')
  return {
    name: draft.name.trim(),
    runner_id: draft.runner_id,
    port,
    proxy_url: draft.proxy_url.trim() || null,
    auth_json: auth,
    max_concurrency: Math.max(1, Number(draft.max_concurrency) || 1),
    rpm_limit: draft.rpm_limit.trim() === '' ? null : Number(draft.rpm_limit),
    enabled: draft.enabled,
  }
}

export default function Accounts() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const accounts = useResource(() => listAccounts(), [])
  const runners = useResource(() => listRunners(), [])
  const [editing, setEditing] = useState<{ account: Account | null; draft: Draft } | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const runnerList = runners.data ?? []
  const list = accounts.data ?? []

  const openEditor = (account: Account | null) => {
    if (!runnerList.length) {
      showToast('info', '先在「Runner」页添加一个 runner')
      return
    }
    setFormError('')
    setEditing({ account, draft: toDraft(account, list, runnerList[0].id) })
  }

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setFormError('')
    try {
      const input = toInput(editing.draft, !editing.account)
      if (editing.account) await updateAccount(editing.account.id, input)
      else await createAccount(input)
      showToast('success', editing.account ? '已保存' : '账号已创建,后台会自动拉起')
      setEditing(null)
      accounts.refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const act = async (account: Account, action: 'start' | 'stop' | 'restart') => {
    setBusy(account.id)
    try {
      await accountAction(account.id, action)
      showToast('success', { start: '已发出启动', stop: '已停止', restart: '已发出重启' }[action])
      window.setTimeout(accounts.refresh, 800)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (account: Account) => {
    const ok = await confirm({
      title: `删除账号 ${account.name}`,
      description: '会先停止它的实例。用量记录保留,但不再关联到这个账号。',
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await deleteAccount(account.id)
      showToast('success', '已删除')
      accounts.refresh()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '删除失败')
    }
  }

  const showLogs = async (account: Account) => {
    try {
      const text = await getAccountLogs(account.id)
      setLogs({ name: account.name, text: text || '(暂无日志)' })
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '读取日志失败')
    }
  }

  const setDraft = (patch: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))

  return (
    <PageShell
      title="账号"
      description="每个账号对应一个独立的 codexs 实例,有自己的端口和出口代理。启用后由后台自动拉起。"
      width="7xl"
      actions={
        <>
          <Button type="button" variant="outline" className="gap-2" onClick={accounts.refresh} disabled={accounts.loading}>
            <RefreshCw className={cn('h-4 w-4', accounts.loading && 'animate-spin')} />
            刷新
          </Button>
          <Button type="button" className="gap-2" onClick={() => openEditor(null)}>
            <Plus className="h-4 w-4" />
            新建账号
          </Button>
        </>
      }
    >
      {accounts.error ? (
        <PageSurface>
          <ErrorState message={accounts.error} onRetry={accounts.refresh} />
        </PageSurface>
      ) : !accounts.data ? (
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
                  <TableHead>状态</TableHead>
                  <TableHead>Runner</TableHead>
                  <TableHead>端口</TableHead>
                  <TableHead className="text-right">并发 / RPM</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.length ? (
                  list.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div className="font-medium">{account.name}</div>
                        <div className="max-w-[28ch] truncate font-mono text-xs text-muted-foreground" title={account.proxy_url ?? ''}>
                          {account.proxy_url || '直连'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={account.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{account.runner_id}</TableCell>
                      <TableCell className="font-mono text-xs">{account.port}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {account.max_concurrency} / {account.rpm_limit ?? '∞'}
                      </TableCell>
                      <TableCell>
                        <OnOff on={account.enabled} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => showLogs(account)}>日志</Button>
                          <Button size="sm" variant="ghost" onClick={() => openEditor(account)}>编辑</Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy === account.id} aria-label="更多操作">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => act(account, 'start')}>启动</DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => act(account, 'restart')}>重启</DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => act(account, 'stop')}>停止</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => remove(account)}>删除</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <EmptyState
                        title="还没有账号"
                        description="点右上角「新建账号」,粘贴 codex login 生成的 auth.json。"
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </PageSurface>
      )}

      {logs ? (
        <PageSurface title={`${logs.name} 的实例日志`} description="最近 300 行。" bodyClassName="p-0" actions={<Button size="sm" variant="ghost" onClick={() => setLogs(null)}>关闭</Button>}>
          <pre className="max-h-[440px] overflow-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-5">{logs.text}</pre>
        </PageSurface>
      ) : null}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => (!open ? setEditing(null) : null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.account ? '编辑账号' : '新建账号'}</DialogTitle>
            <DialogDescription>
              {editing?.account ? 'auth.json 留空则保持不变。' : 'auth.json 来自 codex login 生成的 ~/.codex/auth.json。'}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <FormSection>
              <FormField label="名称" htmlFor="acct-name" required>
                <Input id="acct-name" value={editing.draft.name} onChange={(e) => setDraft({ name: e.target.value })} autoFocus />
              </FormField>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField label="Runner" htmlFor="acct-runner">
                  <Select value={editing.draft.runner_id} onValueChange={(value) => setDraft({ runner_id: value })}>
                    <SelectTrigger id="acct-runner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {runnerList.map((runner) => (
                        <SelectItem key={runner.id} value={runner.id}>
                          {runner.id} ({runner.public_host})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label="实例端口" htmlFor="acct-port" description="同一 runner 内唯一" required>
                  <Input id="acct-port" type="number" value={editing.draft.port} onChange={(e) => setDraft({ port: e.target.value })} />
                </FormField>
              </div>
              <FormField label="出口代理" htmlFor="acct-proxy" description="http://、socks5:// 或 socks5h://,留空直连">
                <Input id="acct-proxy" placeholder="socks5h://127.0.0.1:1080" value={editing.draft.proxy_url} onChange={(e) => setDraft({ proxy_url: e.target.value })} />
              </FormField>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField label="最大并发" htmlFor="acct-conc">
                  <Input id="acct-conc" type="number" value={editing.draft.max_concurrency} onChange={(e) => setDraft({ max_concurrency: e.target.value })} />
                </FormField>
                <FormField label="每分钟请求上限" htmlFor="acct-rpm" description="留空不限">
                  <Input id="acct-rpm" type="number" value={editing.draft.rpm_limit} onChange={(e) => setDraft({ rpm_limit: e.target.value })} />
                </FormField>
              </div>
              <FormField label="auth.json" htmlFor="acct-auth" required={!editing.account}>
                <Textarea
                  id="acct-auth"
                  className="min-h-[110px] font-mono text-xs"
                  placeholder='{"auth_mode":"chatgpt","tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}'
                  value={editing.draft.auth_json}
                  onChange={(e) => setDraft({ auth_json: e.target.value })}
                />
              </FormField>
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={editing.draft.enabled} onCheckedChange={(checked) => setDraft({ enabled: checked })} />
                启用,由后台自动拉起
              </label>
              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            </FormSection>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>取消</Button>
            <Button onClick={save} disabled={saving}>{editing?.account ? '保存' : '创建'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
