import { apiRequest } from '@/api/client'

/**
 * A/B 双槽部署控制面(manager 反代到 deployment 控制服务,令牌不进浏览器)。
 * 变更端点成功返回 202 `{accepted: true}`,任务在后台异步执行;页面靠轮询 GET /deployment 看 operation.stage。
 */

export type Slot = 'a' | 'b'
export const SLOTS: readonly Slot[] = ['a', 'b']
export const otherSlot = (slot: Slot): Slot => (slot === 'a' ? 'b' : 'a')

export interface SlotContainer {
  name: string
  service: string
  state: string
  health?: string
}

export interface SlotStatus {
  /** deploy/state/images.json 记录的镜像 */
  image?: string | null
  /** docker compose 实际运行的镜像 */
  runningImage?: string | null
  role: 'active' | 'standby' | 'unknown'
  /** 容器 healthy 且 HAProxy 后端 UP */
  ready: boolean
  containers: SlotContainer[]
  /** HAProxy 后端当前连接数 / 排队数 */
  connections?: number | null
  queued?: number | null
  /** 该槽的 manager 正持有后台任务 leader 锁 */
  leader?: boolean
  error?: string
}

export type OperationStage = 'idle' | 'preparing' | 'quiescing' | 'cutover' | 'retiring' | (string & {})
export type OperationKind = 'deploy' | 'switch' | 'rollback' | 'init' | (string & {})

export interface DeploymentOperation {
  stage: OperationStage
  kind?: OperationKind
  active?: Slot | null
  candidate?: Slot | null
  image?: string
  retireImage?: string
  startedAt?: number
  updatedAt?: number
  error?: string | null
}

export interface HistoryItem {
  at: string
  kind: string
  from?: string | null
  to?: string | null
  image?: string
  ok: boolean
  error?: string | null
}

export interface RunnerStatus {
  image?: string | null
  runningImage?: string | null
  state?: string | null
  health?: string | null
}

export interface DeploymentStatus {
  /** false → 未配置 A/B 控制服务 */
  enabled: boolean
  busy?: boolean
  /** 持久化的活动槽(active.map) */
  active?: Slot | null
  /** HAProxy 运行时 map;切流瞬间可能与 active 短暂不一致 */
  runtimeActive?: Slot | null
  /** 进程眼里的活动槽(Redis) */
  redisActive?: string | null
  operation?: DeploymentOperation
  slots?: Partial<Record<Slot, SlotStatus>>
  runner?: RunnerStatus
  history?: HistoryItem[]
  /** 状态不完整 → 所有变更禁用 */
  error?: string
  lastError?: string | null
}

export interface ReleaseInfo {
  sha: string
  fullSha?: string | null
  createdAt?: string | null
  image: string
  message?: string | null
  author?: string | null
  runningIn: Array<Slot | 'runner'>
}

export interface ReleasesStatus {
  enabled: boolean
  githubCommits: boolean
  checkedAt?: number
  error?: string | null
  running: { a?: string | null; b?: string | null; runner?: string | null; active?: string | null }
  latest?: ReleaseInfo | null
  updateAvailable: boolean
  releases: ReleaseInfo[]
}

export interface AcceptedResponse {
  accepted: boolean
}

export const getDeploymentStatus = () => apiRequest<DeploymentStatus>('/deployment')
export const getReleases = (refresh = false) => apiRequest<ReleasesStatus>(`/deployment/releases${refresh ? '?refresh=1' : ''}`)

const post = (path: string, body: unknown) => apiRequest<AcceptedResponse>(path, { method: 'POST', body: JSON.stringify(body) })

/** 把镜像装进备用槽 → 就绪 → 切流 → 旧槽按原版本重建为备用 */
export const deployImage = (image: string) => post('/deployment/deploy', { image })
/** 纯切流,两槽版本都不动 */
export const switchTraffic = (target: Slot, expectedActive: Slot) => post('/deployment/switch', { target, expectedActive })
/** 切到备用槽(它保留上一版本) */
export const rollbackTraffic = (expectedActive: Slot) => post('/deployment/rollback', { expectedActive })
/** 继续被打断的操作 */
export const resumeOperation = () => post('/deployment/resume', {})
/** 滚动 runner(实例会重启一次) */
export const rollRunner = (image: string) => post('/deployment/runner', { image })
