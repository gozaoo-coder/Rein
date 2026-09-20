/**
 * 更新域类型 · 与 Rust `modules/update` 一一对应（camelCase 镜像）。
 *
 * 改动这里 = 改 IPC 契约，必须同步改 Rust 的 models 与 `docs/UPDATES.md`。
 */

/** 更新源类型：rein = 本服务的扩展清单（带清单签名）；tauri-static = 官方 static JSON */
export type UpdateSourceKind = 'rein' | 'tauri-static'

export interface UpdateSource {
  id: string
  name: string
  kind: UpdateSourceKind
  /** 清单地址（不是安装包地址） */
  url: string
  enabled: boolean
  /** 越小越优先，仅影响「同时可用时先看谁」 */
  priority: number
}

export interface UpdateSettings {
  enabled: boolean
  channel: string
  autoCheck: boolean
  checkIntervalHours: number
  lastCheckAt: string | null
  /** 见过的最高版本：服务端回放旧清单时用来识别降级 */
  lastSeenVersion: string | null
  /** 用户选择跳过的版本 */
  ignoredVersion: string | null
  /** 允许明文 http 源（自建服务器没有证书；安装包签名仍是硬校验） */
  allowHttp: boolean
  /** Windows 安装模式：true = /S 全静默 */
  silentInstall: boolean
  sources: UpdateSource[]
}

/** 设置补丁：只传要改的字段。清空 ignoredVersion 要传空字符串（null 会被当成「未提供」）。 */
export interface UpdateSettingsPatch {
  enabled?: boolean
  channel?: string
  autoCheck?: boolean
  checkIntervalHours?: number
  ignoredVersion?: string
  allowHttp?: boolean
  silentInstall?: boolean
  sources?: UpdateSource[]
}

export type UpdatePhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'failed'
  | 'cancelled'

/** 单个更新源这次检查的结果（坏源也留痕，界面才能解释「为什么没检查到」） */
export interface SourceReport {
  id: string
  name: string
  kind: UpdateSourceKind
  url: string
  ok: boolean
  version: string | null
  /** 清单签名是否校验通过（没签名的源恒为 false） */
  manifestSigned: boolean
  error: string | null
  elapsedMs: number
}

export interface UpdateCheck {
  checkedAt: string
  currentVersion: string
  platform: string
  available: boolean
  latestVersion: string | null
  notes: string | null
  publishedAt: string | null
  sizeBytes: number | null
  sourceId: string | null
  sourceName: string | null
  sources: SourceReport[]
  mandatory: boolean
  installSupported: boolean
  installHint: string
  /** 命中的版本被用户标记为跳过 */
  ignored: boolean
  /** 清单版本低于见过的新版本（疑似被换了旧版本） */
  downgradeBlocked: boolean
}

export interface DownloadState {
  phase: UpdatePhase
  version: string | null
  target: string
  url: string | null
  sourceName: string | null
  received: number
  total: number
  bytesPerSec: number
  percent: number
  file: string | null
  /** 已通过 sha256 + Ed25519 验签 */
  verified: boolean
  error: string | null
  startedAt: string | null
  updatedAt: string | null
}

export interface UpdateSnapshot {
  currentVersion: string
  platform: string
  installSupported: boolean
  installHint: string
  settings: UpdateSettings
  check: UpdateCheck | null
  download: DownloadState
  readyToInstall: boolean
}

export interface InstallResult {
  ok: boolean
  message: string
  /** Windows 安装器起来后应用会自行退出，前端据此显示「正在安装并重启」 */
  willExit: boolean
}

/* ---------- Rein 在线服务（更新分发之外的能力） ---------- */

export interface ServiceProvider {
  id: string
  name: string
  enabled: boolean
  models: string[]
}

/** 在线模型网关状态（预留接口的服务端形态） */
export interface AiGatewayInfo {
  /** ready = 有可用 provider；not_configured = 服务在线但还没配模型 */
  status: string
  enabled: boolean
  requireToken: boolean
  clientCount: number
  providers: ServiceProvider[]
  /** OpenAI 兼容端点，可直接作为 ai_models.baseUrl（去掉 /v1 后缀） */
  modelsEndpoint: string
  chatEndpoint: string
}

export interface ChannelInfo {
  channel: string
  current: string | null
}

export interface OnlineServiceStatus {
  baseUrl: string
  reachable: boolean
  service: string | null
  version: string | null
  /** 服务端 stable 通道当前发布的版本 */
  currentRelease: string | null
  channels: ChannelInfo[]
  manifestUrl: string | null
  ai: AiGatewayInfo | null
  error: string | null
  checkedAt: string
  elapsedMs: number
}
