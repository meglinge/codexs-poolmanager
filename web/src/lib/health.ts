import type { HealthBucket } from '@/api/usage'

/** 健康条的分桶:把后端按时间桶返回的成功/失败对齐到最近 count 个桶。 */
export interface HealthBlock {
  start: number
  end: number
  success: number
  failed: number
  rate: number | null
}

export function buildBlocks(buckets: HealthBucket[] | undefined, count: number, minutes: number, now: number): HealthBlock[] {
  const size = minutes * 60_000
  const end = Math.floor(now / size) * size + size
  const byStart = new Map<number, { success: number; failed: number }>()
  for (const b of buckets ?? []) {
    const start = Math.floor(new Date(b.bucket).getTime() / size) * size
    const cur = byStart.get(start) ?? { success: 0, failed: 0 }
    byStart.set(start, { success: cur.success + b.success, failed: cur.failed + b.failed })
  }
  const out: HealthBlock[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = end - (i + 1) * size
    const v = byStart.get(start) ?? { success: 0, failed: 0 }
    const total = v.success + v.failed
    out.push({ start, end: start + size, ...v, rate: total ? v.success / total : null })
  }
  return out
}

/** 0 → 红 → 0.5 → 琥珀 → 1 → 薄荷,用本站色板的 HSL 插值。 */
export function rateColor(rate: number): string {
  const t = Math.max(0, Math.min(1, rate))
  const [h, s, l] =
    t < 0.5
      ? [4 + (39 - 4) * (t * 2), 54 + (82 - 54) * (t * 2), 51 + (44 - 51) * (t * 2)]
      : [39 + (165 - 39) * ((t - 0.5) * 2), 82 + (83 - 82) * ((t - 0.5) * 2), 44 + (35 - 44) * ((t - 0.5) * 2)]
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`
}
