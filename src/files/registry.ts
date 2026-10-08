/**
 * 扩展点注册表（列 / 菜单 / 属性 / 预览 / 图标）。
 *
 * 为什么要有这一层：文件管理器要长在**数据**上，不能长在组件里。
 * 「再加一列」「给某类文件多一个菜单项」「属性面板里多一段」如果都要改
 * FileRow / FileExplorer 的模板，加第三样东西时就会开始互相打架。
 * 这里把五类扩展点收敛成五个注册表，内置的那几列/项也只是**第一批注册者** ——
 * 云盘、压缩包、Git 这类将来的 provider 走同一条路进来。
 *
 * 约定：
 * - 注册在模块加载时发生（`registerColumns(...)` 在文件底部调用），顺序即默认显示顺序；
 * - 扩展点**只描述**，不执行副作用：菜单项给 value，由 Explorer 决定怎么执行（各自的能力仍走 provider.capability）；
 * - 全部纯数据 + 纯函数，能单测、能在 mock 与真机上跑出同样结果。
 */

import type { Component } from 'vue'
import { Archive, FileArchive } from 'lucide-vue-next'

import { humanBytes } from '@/utils/format'
import { formatWhen } from './sort'
import type { FileItem, SortKey } from './types'

/* ---------- 列 ---------- */

export interface ColumnDef {
  key: string
  label: string
  /** 固定列宽（px）；`flex: true` 的列吃掉剩余宽度（只允许一列，通常是名称） */
  width?: number
  flex?: boolean
  align?: 'start' | 'end'
  /** 取显示文本（空串 = 这一格空着） */
  value(item: FileItem): string
  /** 给了就能点列头排序 */
  sortKey?: SortKey
  /** 默认是否显示（列菜单里仍可开） */
  defaultVisible?: boolean
  /** 悬停提示（列含义不显然时给一句） */
  hint?: string
}

const columns: ColumnDef[] = []

export function registerColumns(defs: ColumnDef[]): void {
  columns.push(...defs)
}

export function allColumns(): ColumnDef[] {
  return columns
}

/** 按用户选择过滤出可用的列（保持注册顺序） */
export function visibleColumns(visibleKeys: string[] | undefined): ColumnDef[] {
  const keys = visibleKeys ?? columns.filter((c) => c.defaultVisible !== false).map((c) => c.key)
  return keys.map((k) => columns.find((c) => c.key === k)).filter((c): c is ColumnDef => !!c)
}

/* ---------- 上下文菜单附加项 ---------- */

export interface MenuContribution {
  label: string
  value: string
  icon?: Component
  danger?: boolean
}

export interface MenuProvider {
  id: string
  /** 给不出项就返回空数组 */
  items(item: FileItem, ctx: { many: boolean; trashMode: boolean }): MenuContribution[]
}

const menuProviders: MenuProvider[] = []

export function registerMenuProvider(p: MenuProvider): void {
  menuProviders.push(p)
}

export function menuContributions(item: FileItem | null, ctx: { many: boolean; trashMode: boolean }): MenuContribution[] {
  if (!item || ctx.many || ctx.trashMode) return []
  const out: MenuContribution[] = []
  for (const p of menuProviders) out.push(...p.items(item, ctx))
  return out
}

/* ---------- 属性面板附加段 ---------- */

export interface PropertyRow {
  label: string
  value: string
}

export interface PropertyProvider {
  id: string
  /** 这个条目要补充的属性行（空数组 = 不参与） */
  rows(item: FileItem): PropertyRow[]
}

const propertyProviders: PropertyProvider[] = []

export function registerPropertyProvider(p: PropertyProvider): void {
  propertyProviders.push(p)
}

export function propertyRows(item: FileItem): PropertyRow[] {
  const out: PropertyRow[] = []
  for (const p of propertyProviders) out.push(...p.rows(item))
  return out
}

/* ---------- 预览偏好 ---------- */

export interface PreviewProvider {
  id: string
  /** 这个条目该用哪种预览（'reader' = 阅读器，'archive' = 压缩包浏览） */
  prefer(item: FileItem): 'reader' | 'archive' | null
}

const previewProviders: PreviewProvider[] = []

export function registerPreviewProvider(p: PreviewProvider): void {
  previewProviders.push(p)
}

export function preferredPreview(item: FileItem): 'reader' | 'archive' {
  for (const p of previewProviders) {
    const v = p.prefer(item)
    if (v) return v
  }
  return 'reader'
}

/* ---------- 图标 ---------- */

export interface IconProvider {
  id: string
  /** 命中就换掉按 kind 推出来的那个图标 */
  icon(item: FileItem): Component | null
}

const iconProviders: IconProvider[] = []

export function registerIconProvider(p: IconProvider): void {
  iconProviders.push(p)
}

export function iconOverride(item: FileItem): Component | null {
  for (const p of iconProviders) {
    const c = p.icon(item)
    if (c) return c
  }
  return null
}

/* ---------- 判定小工具（provider 们共用） ---------- */

const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz'])

export function isArchiveName(name: string): boolean {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return ARCHIVE_EXT.has(ext)
}

/* ============================================================
   内置注册（第一批扩展点：本来就是文件管理器的默认能力）
   ============================================================ */

registerColumns([
  {
    key: 'name',
    label: '名称',
    flex: true,
    align: 'start',
    defaultVisible: true,
    sortKey: 'name',
    value: (i) => i.displayName,
  },
  {
    key: 'kind',
    label: '类型',
    width: 92,
    align: 'start',
    defaultVisible: true,
    sortKey: 'kind',
    value: (i) => (i.isDir ? '文件夹' : (i.extension ?? '').toUpperCase() || '文件'),
  },
  {
    key: 'size',
    label: '大小',
    width: 84,
    align: 'end',
    defaultVisible: true,
    sortKey: 'size',
    value: (i) =>
      i.isDir ? (i.childCount ? `${i.childCount} 项` : '') : i.size !== undefined ? humanBytes(i.size) : '',
  },
  {
    key: 'modified',
    label: '修改时间',
    width: 96,
    align: 'end',
    defaultVisible: true,
    sortKey: 'modified',
    value: (i) => formatWhen(i.modifiedAt),
  },
  {
    key: 'rating',
    label: '评分',
    width: 68,
    align: 'end',
    defaultVisible: false,
    sortKey: 'rating',
    hint: '你给的评分（0–5）',
    value: (i) => (i.rating ? `${'★'.repeat(Math.min(5, i.rating))}` : ''),
  },
  {
    key: 'tags',
    label: '标签',
    width: 120,
    align: 'start',
    defaultVisible: false,
    hint: '你给的标签',
    value: (i) => i.tags.join(' · '),
  },
  {
    key: 'source',
    label: '来源',
    width: 104,
    align: 'start',
    defaultVisible: false,
    hint: '本条目的来源类别（派生投影才有）',
    value: (i) => (i.sourceType && i.sourceType !== 'note' ? i.sourceType : ''),
  },
])

registerMenuProvider({
  id: 'archive',
  items: (item, ctx) =>
    !ctx.many && isArchiveName(item.name) && item.docId !== undefined && !item.isDir
      ? [{ label: '在压缩包里浏览', value: 'browseArchive', icon: FileArchive }]
      : [],
})

registerPreviewProvider({
  id: 'archive',
  prefer: (item) => (isArchiveName(item.name) && item.docId !== undefined ? 'archive' : null),
})

registerIconProvider({
  id: 'archive',
  icon: (item) => (isArchiveName(item.name) && !item.isDir ? Archive : null),
})

registerPropertyProvider({
  id: 'storage',
  rows: (item) => {
    const out: PropertyRow[] = []
    if (item.isDir) return out
    out.push({ label: '模态', value: item.modalities.join(' / ') || '—' })
    if (item.hasNote) out.push({ label: '注释', value: '有（在详情里编辑）' })
    return out
  },
})
