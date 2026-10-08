/**
 * 排序、分组与名称解析。**纯函数**，不碰 DOM 也不碰 IPC —— 排序切换在 UI 上是高频动作，
 * 每次都重新拉数据是不可接受的（过滤与排序都只是对已有一层的重排）。
 */

import type { FileItem, GroupKey, SortDir, SortKey } from './types'

/* ---------- 名称 ---------- */

/** 已知扩展名：可以在列表里隐去（显示名去尾、扩展名单列一列） */
const KNOWN_EXT = new Set([
  'md',
  'txt',
  'json',
  'csv',
  'html',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'zip',
  'tar',
  'gz',
  'tgz',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'bmp',
  'svg',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
])

/** 拆分扩展名。`deepseek-v3.1.md` → stem `deepseek-v3.1` + ext `md`；无扩展名时 ext 为空。 */
export function splitExt(name: string): { stem: string; ext: string } {
  const cut = name.lastIndexOf('.')
  // 点开头的隐藏文件（.gitignore）整体当 stem，不视为扩展名
  if (cut <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, cut), ext: name.slice(cut + 1).toLowerCase() }
}

export function isKnownExt(ext: string): boolean {
  return KNOWN_EXT.has(ext)
}

/**
 * 显示名：已知扩展名隐去（列表里另有一列「类型」）。
 * 重命名时用户看到的应与排序/显示一致 —— 就地编辑框里给的仍是完整 `name`，
 * 但默认只选中主文件名（见 FileRow 的 input 选择逻辑），扩展名受保护。
 */
export function displayNameOf(name: string, hideExt: boolean): string {
  const { stem, ext } = splitExt(name)
  if (!hideExt) return name
  return ext && isKnownExt(ext) ? stem : name
}

/**
 * 按显示偏好改写条目的展示名（数据层不认识用户偏好，这一层才认识）。
 * 只动 `displayName`，`name` 与 `sortName` 保持不变 —— 开关显示方式不该影响
 * 排序结果、过滤匹配与任何写操作的目标路径。
 */
export function withDisplayName(item: FileItem, hideExt: boolean): FileItem {
  const next = displayNameOf(item.name, hideExt)
  return next === item.displayName ? item : { ...item, displayName: next }
}

/* ---------- 自然排序 ---------- */

/**
 * 自然比较：数字段按数值比，其余按本地化比较（中文按拼音/笔画由 Intl 决定，
 * 与系统文件管理器一致）。`file2 < file10`，`报告2 < 报告10`。
 *
 * 用 `Intl.Collator`（numeric: true）而不是手写分段：它同时解决大小写
 * （`a` 与 `A` 相邻）与中日韩排序，还带缓存，长列表排序比正则分段快。
 */
const collator = new Intl.Collator('zh-Hans-CN', {
  numeric: true,
  sensitivity: 'base',
  ignorePunctuation: false,
})

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b)
}

/** 排序方向对结果取反 */
function orient(n: number, dir: SortDir): number {
  return dir === 'asc' ? n : -n
}

/** 体积档（分组用）：越小越靠前 */
const SIZE_BUCKETS: { max: number; label: string }[] = [
  { max: 64 * 1024, label: '小（< 64 KB）' },
  { max: 1024 * 1024, label: '中（64 KB – 1 MB）' },
  { max: 8 * 1024 * 1024, label: '大（1 – 8 MB）' },
  { max: Number.MAX_SAFE_INTEGER, label: '超大（> 8 MB）' },
]

function sizeBucket(size: number | undefined): { order: number; label: string } {
  const s = size ?? 0
  for (let i = 0; i < SIZE_BUCKETS.length; i++) {
    if (s < SIZE_BUCKETS[i].max) return { order: i, label: SIZE_BUCKETS[i].label }
  }
  return { order: SIZE_BUCKETS.length, label: SIZE_BUCKETS[SIZE_BUCKETS.length - 1].label }
}

const KIND_LABELS: Record<string, string> = {
  folder: '文件夹',
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  file: '其他文件',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/**
 * 排序：目录优先（可关），其后按所选键。
 *
 * 空值一律排在最后 —— 无论升降序（`size` 缺失的目录不该因为降序就跑到最前面）。
 */
export function sortItems(
  items: FileItem[],
  key: SortKey,
  dir: SortDir,
  foldersFirst = true,
): FileItem[] {
  const out = [...items]
  out.sort((a, b) => {
    if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let n = 0
    switch (key) {
      case 'name':
        n = naturalCompare(a.sortName, b.sortName)
        break
      case 'modified': {
        const av = a.modifiedAt ?? 0
        const bv = b.modifiedAt ?? 0
        if (av === 0 || bv === 0) n = av === bv ? 0 : av === 0 ? 1 : -1
        else n = av - bv
        break
      }
      case 'size': {
        const av = a.size ?? -1
        const bv = b.size ?? -1
        if (av < 0 || bv < 0) n = av === bv ? 0 : av < 0 ? 1 : -1
        else n = av - bv
        break
      }
      case 'kind':
        n = naturalCompare(a.kind, b.kind) || naturalCompare(a.sortName, b.sortName)
        break
      case 'rating':
        // 没评分的排最后（与体积/时间同一套「空值沉底」规则）
        n = (a.rating || -1) - (b.rating || -1)
        break
    }
    if (n === 0) n = naturalCompare(a.sortName, b.sortName)
    return orient(n, dir)
  })
  return out
}

/* ---------- 分组 ---------- */

export interface Group {
  key: string
  label: string
  items: FileItem[]
}

/**
 * 分组：类型 / 修改日期（今天 / 昨天 / 本周 / 更早）/ 体积档。
 * 组的顺序是**语义顺序**（今天在前、小文件在前），不跟随升降序 —— 用户排序的是组内。
 */
export function groupItems(items: FileItem[], key: GroupKey): Group[] {
  if (key === 'none') return [{ key: 'all', label: '', items }]
  const buckets = new Map<string, Group>()
  const push = (k: string, label: string, item: FileItem, order: number) => {
    const g = buckets.get(k) ?? { key: `${order}`, label, items: [] }
    g.items.push(item)
    buckets.set(k, g)
  }
  for (const item of items) {
    if (key === 'kind') {
      const order = item.isDir ? 0 : 1
      push(`kind:${item.kind}`, kindLabel(item.kind), item, order)
    } else if (key === 'size') {
      const b = sizeBucket(item.size)
      push(`size:${b.order}`, b.label, item, b.order)
    } else {
      const d = dayBucket(item.modifiedAt)
      push(`day:${d.order}`, d.label, item, d.order)
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => Number(a[1].key) - Number(b[1].key))
    .map(([, g]) => g)
}

/** 日期分组：今天 / 昨天 / 本周 / 本月 / 更早。用自然日而不是「小时差」，跨零点才不会错。 */
function dayBucket(ts: number | undefined): { order: number; label: string } {
  if (!ts) return { order: 9, label: '时间未知' }
  const now = new Date()
  const d = new Date(ts)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86400000
  if (ts >= startOfToday) return { order: 0, label: '今天' }
  if (ts >= startOfToday - day) return { order: 1, label: '昨天' }
  if (ts >= startOfToday - 6 * day) return { order: 2, label: '本周' }
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth())
    return { order: 3, label: '本月' }
  return { order: 4, label: `${d.getFullYear()} 年` }
}

/* ---------- 过滤 ---------- */

/** 名称过滤（大小写不敏感，子串匹配）。搜索是**过滤当前目录**，不是重新枚举磁盘。 */
export function filterItems(items: FileItem[], keyword: string): FileItem[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return items
  return items.filter(
    (i) =>
      i.sortName.includes(kw) ||
      i.displayName.toLowerCase().includes(kw) ||
      (i.extension ?? '').includes(kw) ||
      i.tags.some((t) => t.toLowerCase().includes(kw)),
  )
}

/** 标签过滤：多选时取「都要满足」（与文件管理器里标签过滤的惯例一致） */
export function filterByTags(items: FileItem[], tags: string[]): FileItem[] {
  if (!tags.length) return items
  return items.filter((i) => tags.every((t) => i.tags.includes(t)))
}

/** 当前一层里出现过的标签（按出现次数降序）——给标签筛选条用 */
export function tagCloud(items: FileItem[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || naturalCompare(a.tag, b.tag))
}

/* ---------- 格式化 ---------- */

/** 相对时间：今天显示时刻，今年显示月日，更早显示年月日。 */
export function formatWhen(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

/** 完整时间（悬停提示与详情用） */
export function formatFullWhen(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ---------- 重命名校验 ---------- */

export interface NameCheck {
  ok: boolean
  reason?: string
}

/**
 * 客户端先挡一道（后端仍有 authoritative 校验）：非法字符、长度、保留名、空名。
 * 与 Rust `source::sanitize` 的非法集合保持一致，但这里**报错而不是静默替换** ——
 * 静默换掉用户输入的名字比拒绝更糟。
 */
const ILLEGAL = /[/\\:*?"<>|\n\r\t]/
const RESERVED = new Set(['.', '..', 'con', 'prn', 'aux', 'nul'])

export function checkName(raw: string, name: string): NameCheck {
  const t = raw.trim()
  if (!t) return { ok: false, reason: '名称不能为空' }
  if (t === name) return { ok: false, reason: '名称没有变化' }
  if (t.length > 60) return { ok: false, reason: '名称过长（上限 60 字）' }
  if (ILLEGAL.test(t)) return { ok: false, reason: '名称不能包含 / \\ : * ? " < > |' }
  if (RESERVED.has(t.toLowerCase())) return { ok: false, reason: `「${t}」是保留名称` }
  return { ok: true }
}

/** 扩展名变化（改名时改扩展名要提醒：内容不跟着变，打开方式会错） */
export function extChanged(from: string, to: string): boolean {
  return splitExt(from).ext !== splitExt(to).ext
}
