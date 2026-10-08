/**
 * 文件剪贴板（复制 / 剪切）。
 *
 * 与文本剪贴板的区别（也是「延迟渲染」在这里的含义）：
 * **复制不立刻拷内容**，只记住条目引用；真正的读写在粘贴那一刻发生
 * —— 否则「复制一个 200MB 的视频再顺手删掉它」会先白拷一遍。
 *
 * 剪贴板是应用内的（跨进程真剪贴板要序列化 data URL，代价与收益不成比例），
 * 但语义与系统剪贴板一致：剪切态的原件在 UI 上是半透明的，粘贴成功后才消失。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { kbService } from '@/services/kbService'
import type { ClipMode, FileItem } from './types'

/** 自定义剪贴板 MIME：本应用之间粘贴走它（带操作模式与源路径） */
const MIME_FILES = 'application/x-rein-files'
/** 文本形态：每行一个 `kb://路径`（跨应用至少能把路径带出去） */
const uriOf = (item: FileItem): string => `kb://${item.uri.split('://')[1] ?? item.name}`

export interface SystemClipboardPayload {
  mode: ClipMode
  paths: string[]
}

/**
 * 写系统剪贴板。
 *
 * 两段式：先试「自定义 MIME + text/plain」；Chromium 对非标准类型有时会整个拒绝写入，
 * 那就退成纯文本（`kb://` 一行一个）—— 无论如何，外面至少能粘出一串路径。
 */
export async function writeSystemClipboard(
  items: FileItem[],
  mode: ClipMode,
): Promise<boolean> {
  if (!items.length || typeof navigator === 'undefined' || !navigator.clipboard?.write) return false
  const text = items.map(uriOf).join('\n')
  const payload: SystemClipboardPayload = {
    mode,
    paths: items.map((i) => i.uri.split('://')[1] ?? i.name),
  }
  try {
    const items_: ClipboardItem[] = [
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        [MIME_FILES]: new Blob([JSON.stringify(payload)], { type: MIME_FILES }),
      }),
    ]
    await navigator.clipboard.write(items_)
    return true
  } catch {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 读系统剪贴板。返回 null = 里面没有本应用认得的路径。
 * 路径要**重新解析成当前库里的条目**（剪贴板可能来自上一次启动，id 早就变了；
 * 而 path 是稳定的键）—— 解析不到的直接跳过，不当成错误。
 */
export async function readSystemClipboard(limit = 50): Promise<{ mode: ClipMode; items: FileItem[] } | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return null
  let payload: SystemClipboardPayload | null = null
  let text = ''
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes(MIME_FILES)) {
        payload = JSON.parse(await (await item.getType(MIME_FILES)).text()) as SystemClipboardPayload
      }
      if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text()
    }
  } catch {
    return null
  }
  const paths = payload?.paths ?? text.split('\n').map((l) => l.trim().replace(/^kb:\/\//, '')).filter(Boolean)
  if (!paths.length || paths.length > 200) return null
  const mode: ClipMode = payload?.mode ?? 'copy'
  const items: FileItem[] = []
  for (const path of paths.slice(0, limit)) {
    try {
      // 用 glob 精确取回条目（拿到 id / 真实名称 / 大小）
      const hits = await kbService.glob(path, 5)
      const hit = hits.find((h) => h.path === path)
      if (!hit) continue
      const name = path.split('/').pop() ?? path
      const cut = name.lastIndexOf('.')
      items.push({
        id: `kb:${path}`,
        uri: `kb://${path}`,
        name,
        displayName: name,
        sortName: name.toLowerCase(),
        extension: cut > 0 ? name.slice(cut + 1).toLowerCase() : undefined,
        kind: hit.kind === 'folder' ? 'folder' : 'text',
        isDir: hit.kind === 'folder',
        size: 0,
        modifiedAt: undefined,
        attributes: { hidden: false, readOnly: !hit.editable, system: hit.system },
        permissions: {
          canRead: true,
          canWrite: hit.editable,
          canDelete: hit.editable && !hit.system,
          canRename: hit.editable && !hit.system,
        },
        childCount: 0,
        rating: 0,
        tags: [],
        hasNote: false,
        pinned: false,
        classifyState: '',
        modalities: [],
        docId: hit.id,
        sourceType: hit.sourceType,
        title: hit.title,
        cloudState: 'local',
        providerId: 'kb',
      })
    } catch {
      /* 单条解析失败不影响其它 */
    }
  }
  return items.length ? { mode, items } : null
}

export interface ClipboardApi {
  mode: Ref<ClipMode | null>
  /** 剪贴板里的条目（复制/剪切时快照；粘贴前若源已消失，会由 provider 报错） */
  items: Ref<FileItem[]>
  /** 条目数（状态栏与菜单显示「粘贴 N 项」） */
  count: ComputedRef<number>
  /** 该条目是否处于「已剪切」状态（UI 半透明） */
  isCut(id: string): boolean
  copy(list: FileItem[]): void
  cut(list: FileItem[]): void
  clear(): void
}

export function useFileClipboard(): ClipboardApi {
  const mode = ref<ClipMode | null>(null)
  const items = ref<FileItem[]>([])
  const cutIds = ref<Set<string>>(new Set())

  const count = computed(() => items.value.length)

  function set(next: ClipMode, list: FileItem[]): void {
    mode.value = next
    items.value = [...list]
    cutIds.value = new Set(next === 'cut' ? list.map((i) => i.id) : [])
  }

  return {
    mode,
    items,
    count,
    isCut: (id: string) => cutIds.value.has(id),
    copy: (list) => set('copy', list),
    cut: (list) => set('cut', list),
    clear: () => set('copy', []),
  }
}
