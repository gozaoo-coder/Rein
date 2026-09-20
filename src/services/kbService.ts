/** 知识库域 IPC 封装 · 对应 modules/kb/commands.rs */

import type {
  KbCognition,
  KbDocDetail,
  KbFile,
  KbFileInput,
  KbFsMove,
  KbFsMoveResult,
  KbGlobHit,
  KbHit,
  KbInjection,
  KbMedia,
  KbMediaInput,
  KbMemory,
  KbMemoryScope,
  KbMemoryStats,
  KbMemoryType,
  KbQuery,
  KbSettings,
  KbSettingsInput,
  KbStatus,
  MemoryApplyResult,
  MemoryCandidate,
  MemoryMaintainResult,
} from '@/types'
import { invoke } from './transport'

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

  /** 取喂给系统提示词的紧凑认知块 */
  cognition: () => invoke<KbCognition>('kb_cognition', {}),

  /** 上报「这些记忆被注入过」，用于后续排序 */
  memoryBump: (ids: number[]) => invoke<void>('kb_memory_bump', { ids }),
}
