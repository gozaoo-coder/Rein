/** 知识库域 IPC 封装 · 对应 modules/kb/commands.rs */

import type {
  KbCognition,
  KbDocDetail,
  KbFile,
  KbFileInput,
  KbGlobHit,
  KbHit,
  KbMemory,
  KbMemoryType,
  KbQuery,
  KbSettings,
  KbSettingsInput,
  KbStatus,
  MemoryApplyResult,
  MemoryCandidate,
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

  memories: (memType?: KbMemoryType) => invoke<KbMemory[]>('kb_memories', { memType }),

  /** 落库一次记忆抽取结果（抽取本身在前端调模型完成） */
  memoryApply: (candidates: MemoryCandidate[], chatId?: string, messageIds?: string[]) =>
    invoke<MemoryApplyResult>('kb_memory_apply', { candidates, chatId, messageIds }),

  memoryDelete: (id: number) => invoke<boolean>('kb_memory_delete', { id }),

  /** 按路径模式列文档：* 不跨目录、** 跨目录、? 单字符 */
  glob: (pattern: string, limit = 100) => invoke<KbGlobHit[]>('kb_glob', { pattern, limit }),

  /** 新建或覆盖笔记（内容真源在 kb_files，自动进检索编目） */
  fileWrite: (input: KbFileInput) => invoke<KbFile>('kb_file_write', { input }),

  fileRename: (id: number, path: string) => invoke<KbFile>('kb_file_rename', { id, path }),

  fileDelete: (id: number) => invoke<void>('kb_file_delete', { id }),

  /** 取文件原文（编辑用；kb_read 走分块管线会丢原始换行） */
  fileGet: (id: number) => invoke<KbFile>('kb_file_get', { id }),

  /** 取喂给系统提示词的紧凑认知块 */
  cognition: () => invoke<KbCognition>('kb_cognition', {}),

  /** 上报「这些记忆被注入过」，用于后续排序 */
  memoryBump: (ids: number[]) => invoke<void>('kb_memory_bump', { ids }),
}
