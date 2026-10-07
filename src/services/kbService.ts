/** 知识库域 IPC 封装 · 对应 modules/kb/commands.rs */

import type {
  KbArchiveListing,
  KbArchiveReport,
  KbCognition,
  KbDocDetail,
  KbEmbedCatalog,
  KbEmbedModelInfo,
  KbEmbedTestInput,
  KbEmbedTestResult,
  KbFile,
  KbFileInput,
  KbFsMove,
  KbFsMoveResult,
  KbGlobHit,
  KbHit,
  KbInjection,
  KbIndexEvent,
  KbMedia,
  KbMediaInput,
  KbMemory,
  KbMemoryDiffEntry,
  KbMemoryDuplicate,
  KbMemoryScope,
  KbMemoryStats,
  KbMemoryType,
  KbModelEvent,
  KbQuery,
  KbSettings,
  KbSettingsInput,
  KbStatus,
  KbUsageCleanResult,
  KbUsageReport,
  MemoryApplyResult,
  MemoryCandidate,
  MemoryMaintainResult,
} from '@/types'
import { invoke, isTauri } from './transport'

export const kbService = {
  /** 索引概况：文档/分块/向量数、待处理脏标记、进度、最近错误 */
  status: () => invoke<KbStatus>('kb_status', {}),

  /**
   * 混合检索。结构化过滤（来源类别/日期区间/标签）+ FTS5 + 向量召回，RRF 融合后返回 L0 摘要。
   * query 为空时退化为「按日期倒序浏览」。
   */
  search: (query: KbQuery) => invoke<KbHit[]>('kb_search', { query }),

  /**
   * 分层读取：l1 = 摘要 + 首块（概览）；l2 = 分块正文，支持 offset/limit 分页
   * （docs/kb-vfs.md §3）。响应带 totalChunks / offset / hasMore。
   */
  read: (docId: number, level: 'l1' | 'l2' = 'l1', offset?: number, limit?: number) =>
    invoke<KbDocDetail>('kb_read', { docId, level, offset, limit }),

  /** 全量对账：把现有源记录重新入队并清理孤儿文档。返回入队条数 */
  reindex: (sources?: string[]) => invoke<number>('kb_reindex', { sources }),

  settingsGet: () => invoke<KbSettings>('kb_settings_get', {}),

  settingsSet: (input: KbSettingsInput) => invoke<KbSettings>('kb_settings_set', { input }),

  /** 嵌入后端自检：返回向量维度 */
  probeEmbedder: () => invoke<number>('kb_probe_embedder', {}),

  /** 清空全部向量并按当前模型重算 */
  rebuildVectors: () => invoke<number>('kb_rebuild_vectors', {}),

  /** 记忆列表。scope: active（默认）/ archived / all */
  memories: (memType?: KbMemoryType, scope?: KbMemoryScope) =>
    invoke<KbMemory[]>('kb_memories', { memType, scope }),

  /** 落库一次记忆抽取/整理结果（抽取与整理本身在前端调模型完成） */
  memoryApply: (candidates: MemoryCandidate[], chatId?: string, messageIds?: string[]) =>
    invoke<MemoryApplyResult>('kb_memory_apply', { candidates, chatId, messageIds }),

  memoryDelete: (id: number) => invoke<boolean>('kb_memory_delete', { id }),

  /** 归档一条记忆（软删除，可恢复） */
  memoryArchive: (id: number, reason?: string) =>
    invoke<boolean>('kb_memory_archive', { id, reason }),

  /** 恢复一条已归档记忆 */
  memoryRestore: (id: number) => invoke<boolean>('kb_memory_restore', { id }),

  /** 立即跑一次本地维护（衰减 + 自动归档） */
  memoryMaintain: () => invoke<MemoryMaintainResult>('kb_memory_maintain', {}),

  /** 记忆库信噪比概况（注入覆盖率 / 噪声占比 / 归档数 / 上次整理时间） */
  memoryStats: () => invoke<KbMemoryStats>('kb_memory_stats', {}),

  /** 上报「刚完成一次 LLM 整理」，用于周期任务的节流 */
  memoryConsolidated: () => invoke<void>('kb_memory_consolidated', {}),

  /** 按路径模式列文档：* 不跨目录、** 跨目录、? 单字符 */
  glob: (pattern: string, limit = 100) => invoke<KbGlobHit[]>('kb_glob', { pattern, limit }),

  /** 新建或覆盖笔记（内容真源在 kb_files，自动进检索编目） */
  fileWrite: (input: KbFileInput) => invoke<KbFile>('kb_file_write', { input }),

  fileRename: (id: number, path: string) => invoke<KbFile>('kb_file_rename', { id, path }),

  fileDelete: (id: number) => invoke<void>('kb_file_delete', { id }),

  /** 取文件原文（编辑用；kb_read 走分块管线会丢原始换行） */
  fileGet: (id: number) => invoke<KbFile>('kb_file_get', { id }),

  /**
   * 上传 / 产出一个多模态节点（ai-workspace §2）：本体落盘 + 文本模态入索引。
   * `dataBase64` 可带 data URL 前缀；文本模态缺省时后端生成描述行（保证可检索）。
   */
  mediaWrite: (input: KbMediaInput) => invoke<KbFile>('kb_media_write', { input }),

  /**
   * 读一次模态。给了 modal 就取本体（不可用则降级为文本并给原因），不给只回模态清单。
   * 本体超过内联上限时返回 tooLarge，只给元信息。
   */
  mediaGet: (docId: number, modal?: string) => invoke<KbMedia>('kb_media_get', { docId, modal }),

  /* ---------- 目录治理（ai-workspace §3.3） ---------- */

  /** 把文件移进目标目录（分类）。source='ai' 时有防抖与 pin 保护 */
  fsMove: (id: number, toDir: string, reason?: string, source: 'ai' | 'user' = 'user') =>
    invoke<KbFsMoveResult>('kb_fs_move', { id, toDir, reason, source }),

  /** 建目录（空目录也会在文件树里可见） */
  fsMkdir: (path: string, reason?: string, source: 'ai' | 'user' = 'user') =>
    invoke<KbFile>('kb_fs_mkdir', { path, reason, source }),

  /** 钉住 / 取消钉住（钉住后 AI 不再自动移动） */
  fsPin: (id: number, pinned: boolean, source: 'ai' | 'user' = 'user') =>
    invoke<KbFile>('kb_fs_pin', { id, pinned, source }),

  /** 整理审计流水（最近的在前） */
  fsMoves: (limit = 50) => invoke<KbFsMove[]>('kb_fs_moves', { limit }),

  /** 整批撤销一批整理，返回撤销条数 */
  fsUndo: (batchId: string) => invoke<number>('kb_fs_undo', { batchId }),

  /* ---------- 全量注入区（ai-workspace §3.4） ---------- */

  /** 取「系统提示词 + 用户记忆」注入块（前端带 TTL 缓存，不必每轮都取） */
  injection: () => invoke<KbInjection>('kb_injection_get', {}),

  /* ---------- 压缩包（打开 / 解压） ---------- */

  /** 打开压缩包：列出包内条目（不解压）。docId 用 glob 查 */
  archiveList: (docId: number) => invoke<KbArchiveListing>('kb_archive_list', { docId }),

  /** 解压进工作区：文本进检索、二进制落本体；同名自动让位 */
  archiveExtract: (docId: number, toDir?: string, only?: string[]) =>
    invoke<KbArchiveReport>('kb_archive_extract', { docId, toDir, only }),

  /* ---------- 空间管理 ---------- */

  /** 占用总览（文本 / 本体 / 索引 / 数据库 + 大文件榜 + 孤儿统计） */
  usage: (top = 20) => invoke<KbUsageReport>('kb_usage', { top }),

  /** 清理磁盘上无人引用的本体碎片（dryRun 只统计） */
  usageClean: (dryRun = false) => invoke<KbUsageCleanResult>('kb_usage_clean', { dryRun }),

  /* ---------- 本地嵌入模型（多档可选 / 按需下载） ---------- */

  /** 可选模型目录 + 安装状态 + 当前选择 */
  embedModels: () => invoke<KbEmbedCatalog>('kb_embed_models', {}),

  /** 下载一个本地模型（进度走 kb://model 事件）；已安装则直接返回 */
  embedModelDownload: (modelId: string) =>
    invoke<KbEmbedModelInfo>('kb_embed_model_download', { modelId }),

  /** 取消进行中的下载 */
  embedModelCancel: (modelId: string) => invoke<void>('kb_embed_model_cancel', { modelId }),

  /** 删除已下载的模型（当前正在用的会被拒绝），返回释放字节数 */
  embedModelRemove: (modelId: string) => invoke<number>('kb_embed_model_remove', { modelId }),

  /** 自定义嵌入测试：自己的文本 → 维度 / 延迟 / 相似度排序（可临时换模型对比） */
  embedTest: (input: KbEmbedTestInput) => invoke<KbEmbedTestResult>('kb_embed_test', { input }),

  /* ---------- 记忆整理：查重提示与审计 ---------- */

  /** 疑似重复的记忆对（本地向量算余弦，零模型成本；keyword 模式返回空） */
  memoryDuplicates: (threshold?: number, limit = 30) =>
    invoke<KbMemoryDuplicate[]>('kb_memory_duplicates', { threshold, limit }),

  /** 最近的记忆变更记录（抽取 / 整理 / 维护都写在同一张审计表） */
  memoryDiffs: (limit = 5) => invoke<KbMemoryDiffEntry[]>('kb_memory_diffs', { limit }),

  /** 取喂给系统提示词的紧凑认知块 */
  cognition: () => invoke<KbCognition>('kb_cognition', {}),

  /** 上报「这些记忆被注入过」，用于后续排序 */
  memoryBump: (ids: number[]) => invoke<void>('kb_memory_bump', { ids }),
}

/* ---------- 索引进度事件（kb://index，对应 Rust worker.rs::INDEX_EVENT） ---------- */

const indexListeners = new Set<(e: KbIndexEvent) => void>()
let indexBridged = false

function dispatchIndex(payload: KbIndexEvent): void {
  for (const l of indexListeners) l(payload)
}

async function bridgeIndexEvents(): Promise<void> {
  if (indexBridged) return
  indexBridged = true
  // 浏览器 mock 没有索引线程，不产事件 —— 页面靠进入时的一次 kb_status 快照兜底
  if (!isTauri) return
  const { listen } = await import('@tauri-apps/api/event')
  await listen<KbIndexEvent>('kb://index', (e) => dispatchIndex(e.payload))
}

/**
 * 订阅索引进度推送（页面必须在卸载时取消订阅，否则重挂载会重复派发）。
 * 事件与 `kb_status` 的 progress/pending/indexing 同源，直接就地覆盖即可。
 */
export async function onKbIndexProgress(cb: (e: KbIndexEvent) => void): Promise<() => void> {
  await bridgeIndexEvents()
  indexListeners.add(cb)
  return () => indexListeners.delete(cb)
}

/* ---------- 模型下载进度事件（kb://model，对应 Rust commands.rs 的 MODEL_EVENT） ---------- */

const modelListeners = new Set<(e: KbModelEvent) => void>()
let modelBridged = false

async function bridgeModelEvents(): Promise<void> {
  if (modelBridged) return
  modelBridged = true
  if (!isTauri) return
  const { listen } = await import('@tauri-apps/api/event')
  await listen<KbModelEvent>('kb://model', (e) => {
    for (const l of modelListeners) l(e.payload)
  })
}

export async function onKbModelProgress(cb: (e: KbModelEvent) => void): Promise<() => void> {
  await bridgeModelEvents()
  modelListeners.add(cb)
  return () => modelListeners.delete(cb)
}
