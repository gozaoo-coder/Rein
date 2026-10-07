/**
 * 浏览器 mock 的压缩包解析（jszip）。
 *
 * 接口形状与 Rust `modules/kb/archive.rs` 对齐，安全护栏同样照搬（zip-slip / 绝对路径 /
 * 体积与条目上限），这样 e2e 与真机行为一致。**只支持 zip**：jszip 的能力边界就是 zip，
 * tar / gz 在浏览器里没有现成实现，mock 会如实报「不支持」——真实能力以 Rust 侧为准。
 */

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

export async function mockArchiveList(dataUrl: string, name: string): Promise<MockArchiveListing> {
  const zip = await openZip(dataUrl)
  const entries: MockArchiveEntry[] = []
  const notes: string[] = []
  let unsafe = 0
  const names = Object.keys(zip.files)
  for (const raw of names) {
    const f = zip.files[raw]
    const isDir = f.dir
    const clean = cleanPath(raw)
    if (!clean) {
      unsafe++
      notes.push(`跳过可疑路径：${raw}`)
      continue
    }
    const inner = isDir ? null : await f.async('uint8array')
    const size = inner ? inner.length : 0
    const skip = size > MAX_FILE_BYTES ? `单文件超过上限（${MAX_FILE_BYTES / 1048576} MB）` : null
    entries.push({
      path: clean,
      size,
      packed: 0,
      isDir,
      text:
        !isDir &&
        !skip &&
        TEXT_EXTS.includes(extOf(clean)) &&
        size <= MAX_TEXT_BYTES &&
        decodeText(inner!) !== null,
      skipped: skip,
    })
  }
  const totalBytes = entries.reduce((s, e) => s + e.size, 0)
  const truncated = entries.length > LIST_CAP
  if (truncated) notes.push(`条目较多，只显示前 ${LIST_CAP} 条（共 ${entries.length} 条）`)
  if (unsafe > 0) notes.push(`${unsafe} 个条目带不安全路径（绝对路径 / .. / 盘符），已跳过`)
  void name
  return {
    format: 'zip',
    entries: entries.slice(0, LIST_CAP),
    total: entries.length,
    totalBytes,
    packedBytes: 0,
    truncated,
    notes,
  }
}

export async function mockArchiveExtract(
  dataUrl: string,
  name: string,
  opts: { toDir?: string; only?: string[] },
): Promise<MockArchiveReport> {
  const listing = await mockArchiveList(dataUrl, name)
  const target = opts.toDir?.trim()
    ? opts.toDir.trim().replace(/^\/+|\/+$/g, '')
    : `未分类数据/解压/${name.replace(/\.[^.]+$/, '').slice(0, 40) || '压缩包'}`
  const only = (opts.only ?? []).filter(Boolean)
  const zip = await openZip(dataUrl)
  const files: MockArchiveFile[] = []
  const skipped: string[] = [...listing.notes]
  let bytes = 0
  let truncated = false

  for (const entry of listing.entries) {
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
    const f = zip.files[entry.path] ?? zip.files[Object.keys(zip.files).find((k) => cleanPath(k) === entry.path) ?? '']
    if (!f) continue
    const data = await f.async('uint8array')
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
    const b64 = entry.text
      ? ''
      : btoa(String.fromCharCode(...data.subarray(0, Math.min(data.length, 32 * 1024 * 1024) as number)))
    files.push({
      path: inner,
      text,
      mime,
      bytes: data.length,
      dataUrl: entry.text ? '' : `data:${mime};base64,${b64}`,
    })
    bytes += data.length
  }

  return { format: 'zip', target, files, skipped, bytes, truncated }
}
