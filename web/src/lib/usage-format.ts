/**
 * 用量面板的格式化:紧凑数字(1.2K / 3.4M)、美元、时长、倒计时。
 * 与 codex2api 的 usageFormat 口径一致:默认紧凑,用户可切换显示完整数字。
 */

const FULL_KEY = 'poolmanager:usage-full-numbers'

export function readFullNumbers(): boolean {
  try {
    return window.localStorage.getItem(FULL_KEY) === '1'
  } catch {
    return false
  }
}

export function writeFullNumbers(on: boolean) {
  try {
    window.localStorage.setItem(FULL_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function formatCompact(value: number | null | undefined, full = false): string {
  if (value == null || Number.isNaN(value)) return '—'
  if (full || Math.abs(value) < 1000) return new Intl.NumberFormat('zh-CN').format(Math.round(value))
  const abs = Math.abs(value)
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [div, suffix] of units) {
    if (abs >= div) {
      const n = value / div
      return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)}${suffix}`
    }
  }
  return String(value)
}

export function formatUsd(value: number | null | undefined, digits?: number): string {
  if (value == null || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  const d = digits ?? (abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2)
  return `$${value.toFixed(d)}`
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits).replace(/\.0+$/, '')}%`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/** 秒数 → `5h 12m` / `3d 4h`。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** ISO 时间 → 距现在的倒计时(未来)或“已过”(过去)。 */
export function countdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Math.round((t - now) / 1000)
  return diff <= 0 ? '已到期' : formatDuration(diff)
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Math.round((now - t) / 1000)
  if (diff < 5) return '刚刚'
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(d)
}

export function formatDateTimeFull(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d)
}

/** 窗口秒数 → “5 小时” / “7 天” 这类标签。 */
export function windowLabel(seconds: number | null | undefined): string {
  if (!seconds) return '窗口'
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  return formatDuration(seconds)
}

/** 官方 client_id → 中文标签。 */
export const CLIENT_LABEL: Record<string, string> = {
  CODEX_CLI: 'CLI',
  CODEX_DESKTOP_APP: '桌面端',
  CODEX_WORK_DESKTOP: '桌面端(工作区)',
  CODEX_IDE_VSCODE: 'VS Code',
  CODEX_IDE_JETBRAINS: 'JetBrains',
  CODEX_WEB: '网页',
  CODEX_WORK_WEB: '网页(工作区)',
  CODEX_SDK_TS: 'SDK',
  CODEX_SERVICE_EXEC: 'exec',
  CODEX_GITHUB: 'GitHub',
  CODEX_UNKNOWN_DEFAULT: '网关 / 未标识',
}

export const clientLabel = (id: string) => CLIENT_LABEL[id] ?? id.replace(/^CODEX_/, '').toLowerCase()

/** 成功率 → 颜色档位,与 codex2api 健康条一致:≥90 绿、≥50 琥珀、其余红。 */
export function rateTone(rate: number | null): 'good' | 'warn' | 'bad' | 'idle' {
  if (rate == null) return 'idle'
  if (rate >= 90) return 'good'
  if (rate >= 50) return 'warn'
  return 'bad'
}
