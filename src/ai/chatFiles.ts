/**
 * 聊天里的工作区文件卡片：AI 用 `present_file` 把一份产出（刚写的笔记 / 解压出来的文件 /
 * 用户一直在找的那份东西）挂到气泡下面，用户点开就能看（阅读器或文件管理器）。
 *
 * 为什么要有这一层：工具结果是给模型看的 JSON 文本，卡片是给用户看的视图 ——
 * 中间这一步的判据只有「工具名 + 载荷里的 file」两件事。不靠猜字段名，也不让别的工具
 * （read_modal 的模态清单、glob 的 items）被误挂成卡片。
 * 形状真源：Rust `kb::run_present_file` 的返回（浏览器 mock 模式的镜像在 tools/workspace.ts）。
 */

import type { KbEntry } from '@/types'

/** 挂文件的工具名（Rust 注册表与 TS 镜像同名） */
export const PRESENT_FILE_TOOL = 'present_file'

/** 一条消息最多挂几张：模型偶尔会连着挂一屏，卡片墙反而没人点（工具描述里也写了 1~3 张） */
export const MAX_CHAT_FILES = 4

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback
}

/** 工具结果载荷 → 文件卡片条目（形状不认就返回 null：宁可少一张卡，不要半张坏卡） */
export function fileAttachmentOf(toolName: string, details: unknown): KbEntry | null {
  if (toolName !== PRESENT_FILE_TOOL) return null
  const raw = (details as { file?: unknown } | null)?.file
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Partial<KbEntry>
  if (typeof e.path !== 'string' || !e.path.trim()) return null
  if (typeof e.name !== 'string' || !e.name.trim()) return null
  // 字段逐个兜底：卡片只读这几个，缺一项就退化一项，不让整张卡因为一个空字段消失
  return {
    id: num(e.id),
    fileId: typeof e.fileId === 'number' ? e.fileId : null,
    path: e.path,
    name: e.name,
    kind: str(e.kind, 'text'),
    sourceType: str(e.sourceType, ''),
    title: str(e.title, e.name),
    system: e.system === true,
    editable: e.editable === true,
    size: num(e.size),
    childCount: num(e.childCount),
    occurredOn: typeof e.occurredOn === 'string' ? e.occurredOn : null,
    updatedAt: str(e.updatedAt, ''),
    pinned: e.pinned === true,
    classifyState: str(e.classifyState, ''),
    modalities: Array.isArray(e.modalities)
      ? e.modalities.filter((m): m is string => typeof m === 'string')
      : [],
    // 用户侧标记（评分 / 标签 / 注释）：卡片不用，但条目形状要与文件管理器一致
    rating: num(e.rating),
    tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
    hasNote: e.hasNote === true,
  }
}

/** 同一份文件被挂两次（模型重试 / 同一轮多个工具）时只留一张 */
export function dedupeFiles(list: KbEntry[]): KbEntry[] {
  const out: KbEntry[] = []
  for (const f of list) if (!out.some((x) => x.path === f.path)) out.push(f)
  return out
}
