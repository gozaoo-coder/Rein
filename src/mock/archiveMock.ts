/**
 * 浏览器 mock 的压缩包解析（jszip）。
 *
 * 接口形状与 Rust `modules/kb/archive.rs` 对齐，安全护栏同样照搬（zip-slip / 绝对路径 /
 * 条目体积与总数 / 压缩比），这样 e2e 与真机行为一致。**只支持 zip**：jszip 的能力边界
 * 就是 zip，tar / gz 在浏览器里没有现成实现，mock 会如实报「不支持」——真实能力以 Rust
 * 侧为准。与真机的已知差异都写在 `skipped` 的文案里（例如浏览器不落盘本体）。
 */

import { bytesToBase64 } from '@/utils/image'

/** 与 Rust `TEXT_EXTS` 同口径：这些扩展名按文本节点入库（可检索）。 */
const TEXT_EXTS = [
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html',
  'htm', 'log', 'ini', 'conf', 'toml', 'srt', 'vtt', 'js', 'ts', 'py', 'rs', 'go', 'java', 'c',
  'h', 'cpp', 'sh', 'sql', 'css',
]

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 512 * 1024
const MAX_FILES = 300
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const LIST_CAP = 500
const MAX_INNER_DEPTH = 3
/** 压缩比闸门（与 Rust 同值同义） */
const RATIO_MAX = 200
const RATIO_FLOOR = 64 * 1024 * 1024
/** 文本判定的头部采样长度（与 Rust 的 4096 一致） */
const SAMPLE_BYTES = 4096
/** 提示条数上限（与 Rust NOTES_MAX 一致） */
const NOTES_MAX = 10
/** 浏览器里把本体编成 dataUrl 的体积上限：真机是把字节写进 workspace/media/，
 *  浏览器没有磁盘，几十 MB 的 base64 字符串会直接把页面拖死。超了如实跳过。 */
const MOCK_BINARY_CAP = 32 * 1024 * 1024

/** 可写的根目录（对齐 Rust models.rs 的 WRITABLE_ROOTS + DOMAIN_ROOTS） */
const KNOWN_ROOTS = [
  '笔记', '文档', '用户记忆', '未分类数据', '语音', '视频',
  '日程', '运动', '饮食', '体测', '课程', '食物', '方案', '菜单', '对话', '附件', '记忆', '纪要',
]
const INBOX_ROOT = '未分类数据'

export interface MockArchiveEntry {
  path: string
  size: number
  packed: number
  isDir: boolean
  text: boolean
  skipped: string | null
}

export interface MockArchiveListing {
  format: string
  entries: MockArchiveEntry[]
  total: number
  totalBytes: number
  packedBytes: number
  truncated: boolean
  notes: string[]
}

export interface MockArchiveFile {
  path: string
  /** 文本按内容给；二进制给 dataUrl + mime + bytes */
  text: string | null
  mime: string
  bytes: number
  dataUrl: string
}

export interface MockArchiveReport {
  format: string
  target: string
  files: MockArchiveFile[]
  skipped: string[]
  bytes: number
  truncated: boolean
}

/** data URL / 裸 base64 → 字节 */
function toBytes(dataUrl: string): Uint8Array {
  const payload = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
  const bin = atob(payload.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 路径净化：拒绝绝对路径 / 盘符 / `..`；逐段清掉非法字符（对齐 Rust clean_path）。 */
function cleanPath(raw: string): string | null {
  const norm = raw.replace(/\\/g, '/')
  if (norm.startsWith('/') || norm.startsWith('~')) return null
  if (norm.length >= 2 && norm[1] === ':') return null
  const segs: string[] = []
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    // 控制字符（含换行/制表）先清掉，再换掉文件系统不接受的字符：与 Rust sanitize 同口径
    const cleaned = seg
      .split('')
      .filter((ch) => ch.charCodeAt(0) >= 32)
      .join('')
      .replace(/[\\:*?"<>|]/g, '-')
      .trim()
      .slice(0, 60)
    if (cleaned) segs.push(cleaned)
  }
  return segs.length ? segs.join('/') : null
}

const extOf = (name: string): string => (name.split('.').pop() ?? '').toLowerCase()

/** 记一条提示；超过上限的只计数（与 Rust `note()` 同口径）。返回 1 表示被压掉。 */
function note(notes: string[], msg: string): number {
  if (notes.length < NOTES_MAX) {
    notes.push(msg)
    return 0
  }
  return 1
}

/** 文本判定：扩展名 + 体积 + 头部采样无 NUL（对齐 Rust looks_text；大文件不做内容判定）。 */
function looksText(name: string, size: number, sample: Uint8Array | null): boolean {
  if (!TEXT_EXTS.includes(extOf(name))) return false
  if (size > MAX_TEXT_BYTES) return false
  return !sample || !sample.includes(0)
}

/**
 * JSZip 条目的体积元信息（不解压就能拿到）。
 *
 * jszip 3.10 的 ZipObject 把尺寸放在私有 `_data` 上（没有公开 API）。**拿不到就退化为
 * 解压一次**：升级 jszip 最多让 mock 慢一点，不会拿错数——这条比"绝对不碰内部字段"重要，
 * 因为「列清单就把整包解开」正是要修掉的毛病（几百 MB 的包会把页面卡死）。
 */
function entrySizes(f: unknown): { size: number; packed: number } | null {
  const data = (f as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data
  if (!data || typeof data.uncompressedSize !== 'number') return null
  return {
    size: data.uncompressedSize,
    packed: typeof data.compressedSize === 'number' ? data.compressedSize : 0,
  }
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function openZip(dataUrl: string): Promise<import('jszip')> {
  const JSZip = (await import('jszip')).default
  const bytes = toBytes(dataUrl)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('浏览器 mock 只支持 zip（tar / gz 请在真实应用里解开）')
  }
  return JSZip.loadAsync(bytes)
}

/** 压缩比闸门（与 Rust check_ratio 同文案） */
function checkRatio(entries: MockArchiveEntry[]): void {
  const total = entries.reduce((s, e) => s + e.size, 0)
  const packed = entries.reduce((s, e) => s + e.packed, 0)
  if (total > RATIO_FLOOR && packed > 0 && total / Math.max(1, packed) > RATIO_MAX) {
    throw new Error(
      `压缩比异常（解压后约 ${Math.floor(total / 1048576)} MB，压缩包仅 ${Math.floor(packed / 1024)} KB），出于安全考虑拒绝解压`,
    )
  }
}

/** 解析出**全量**条目（list 与 extract 共用；extract 不再受 list 的 500 条截断影响）。 */
async function loadEntries(
  dataUrl: string,
): Promise<{ zip: import('jszip'); entries: MockArchiveEntry[]; notes: string[] }> {
  const zip = await openZip(dataUrl)
  const entries: MockArchiveEntry[] = []
  const notes: string[] = []
  let unsafe = 0
  let suppressed = 0
  for (const raw of Object.keys(zip.files)) {
    const f = zip.files[raw]
    const clean = cleanPath(raw)
    if (!clean) {
      unsafe++
      suppressed += note(notes, `跳过可疑路径：${raw}`)
      continue
    }
    const isDir = f.dir
    let size = 0
    let packed = 0
    let sample: Uint8Array | null = null
    if (!isDir) {
      const meta = entrySizes(f)
      if (meta) {
        size = meta.size
        packed = meta.packed
        // 只对小文件取头部样本（与 Rust 一致：大文件不做内容判定，也就不解压）
        if (size > 0 && size <= SAMPLE_BYTES) sample = await f.async('uint8array')
      } else {
        const inner = await f.async('uint8array')
        size = inner.length
        sample = inner.length <= SAMPLE_BYTES ? inner : null
      }
    }
    const skip = size > MAX_FILE_BYTES ? `单文件超过上限（${MAX_FILE_BYTES / 1048576} MB）` : null
    entries.push({
      path: clean,
      size,
      packed,
      isDir,
      text: !isDir && !skip && looksText(clean, size, sample),
      skipped: skip,
    })
  }
  checkRatio(entries)
  if (unsafe > 0) {
    notes.push(`${unsafe} 个条目带不安全路径（绝对路径 / .. / 盘符），已跳过`)
  }
  if (suppressed > 0) notes.push(`另有 ${suppressed} 条同类提示已省略`)
  return { zip, entries, notes }
}

export async function mockArchiveList(dataUrl: string, name: string): Promise<MockArchiveListing> {
  const { entries, notes } = await loadEntries(dataUrl)
  const totalBytes = entries.reduce((s, e) => s + e.size, 0)
  const packedBytes = entries.reduce((s, e) => s + e.packed, 0)
  const truncated = entries.length > LIST_CAP
  if (truncated) notes.push(`条目较多，只显示前 ${LIST_CAP} 条（共 ${entries.length} 条）`)
  void name
  return {
    format: 'zip',
    entries: entries.slice(0, LIST_CAP),
    total: entries.length,
    totalBytes,
    packedBytes,
    truncated,
    notes,
  }
}

/** 落点目录归位（对齐 Rust normalize_target_dir）：净化逐段、拒绝 `..`、未知根落收件箱。 */
function normalizeTargetDir(raw: string | undefined, name: string): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) {
    const stem = name.replace(/\.[^.]+$/, '').slice(0, 40) || '压缩包'
    return `${INBOX_ROOT}/解压/${stem}`
  }
  const segs: string[] = []
  for (const seg of trimmed.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw new Error(`路径不允许包含 ..：${trimmed}`)
    const cleaned = cleanPath(seg)
    if (cleaned) segs.push(cleaned)
  }
  if (!segs.length) throw new Error('落点目录不能为空')
  if (!KNOWN_ROOTS.includes(segs[0])) segs.unshift(INBOX_ROOT)
  return segs.join('/')
}

export async function mockArchiveExtract(
  dataUrl: string,
  name: string,
  opts: { toDir?: string; only?: string[] },
): Promise<MockArchiveReport> {
  // 一次解析两用：清单与解压不再各解析一遍（旧实现连 openZip 都跑了两次）
  const { zip, entries, notes } = await loadEntries(dataUrl)
  const target = normalizeTargetDir(opts.toDir, name)
  const only = (opts.only ?? []).filter(Boolean)
  const files: MockArchiveFile[] = []
  const skipped: string[] = [...notes]
  let bytes = 0
  let truncated = false

  for (const entry of entries) {
    if (entry.isDir) continue
    if (only.length && !only.some((p) => entry.path.includes(p))) continue
    if (entry.skipped) {
      skipped.push(`${entry.path}（${entry.skipped}）`)
      continue
    }
    if (files.length >= MAX_FILES) {
      truncated = true
      skipped.push(`条目超过 ${MAX_FILES} 个，其余未解压`)
      break
    }
    if (bytes >= MAX_TOTAL_BYTES) {
      truncated = true
      skipped.push('解压总量超过上限，其余未解压')
      break
    }
    if (!entry.text && entry.size > MOCK_BINARY_CAP) {
      skipped.push(
        `${entry.path}（浏览器预览不落盘超过 ${MOCK_BINARY_CAP / 1048576} MB 的本体，请在真机里解压）`,
      )
      continue
    }
    const raw = Object.keys(zip.files).find((k) => cleanPath(k) === entry.path)
    const f = raw ? zip.files[raw] : undefined
    if (!f) continue
    const data = await f.async('uint8array')
    const remaining = MAX_TOTAL_BYTES - bytes
    if (data.length > remaining) {
      truncated = true
      skipped.push(`${entry.path}（超出剩余空间预算）`)
      continue
    }
    const segs = entry.path.split('/')
    const inner =
      segs.length <= MAX_INNER_DEPTH
        ? entry.path
        : `${segs.slice(0, MAX_INNER_DEPTH - 1).join('/')}/${segs.slice(MAX_INNER_DEPTH - 1).join('-')}`
    const text = entry.text ? decodeText(data) : null
    if (entry.text && text === null) {
      skipped.push(`${entry.path}（文本解码失败）`)
      continue
    }
    const mime = entry.text ? 'text/plain' : 'application/octet-stream'
    files.push({
      path: inner,
      text,
      mime,
      // 文本按 UTF-8 字节数上报（真机是字节，不是 JS 的 UTF-16 码元数）
      bytes: entry.text ? new TextEncoder().encode(text ?? '').length : data.length,
      dataUrl: entry.text ? '' : `data:${mime};base64,${bytesToBase64(data)}`,
    })
    bytes += data.length
  }

  return { format: 'zip', target, files, skipped, bytes, truncated }
}
