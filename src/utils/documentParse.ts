/**
 * Office 文档（OOXML）前端解析：docx / pptx / xlsx 文本 + 内嵌图片抽取。
 *
 * 格式本质：三类文件都是 ZIP 容器（JSZip 解包）+ XML 正文 + media/ 图片目录，
 * 图片与正文的对应关系靠各 part 的 .rels 关系文件映射。
 * 仅支持 2007+ 新格式；.doc/.ppt/.xls 为二进制 OLE 结构，浏览器内无法解析，
 * 明确报错提示转存。EMF/WMF/TIFF 图片 WebView 无法渲染，跳过并计数。
 */

export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'text'

/** 文档内嵌图片（原始字节，发送前由调用方压缩） */
export interface DocImage {
  id: string
  mime: string
  bytes: Uint8Array
  /** 归属说明（给模型的上下文）："第3页" / "第12段" / "工作簿内嵌图" */
  where: string
}

export interface ParsedDoc {
  kind: OfficeKind
  /** 抽取的文本（已截断到 MAX_DOC_TEXT，进聊天 prompt 用） */
  text: string
  /** 全文（未截断）。prompt 只带 text；归档进知识库用 fullText，AI 经分页读取全文 */
  fullText: string
  /** 截断前的总字符数 */
  chars: number
  truncated: boolean
  images: DocImage[]
  /** 因格式不支持/过小/重复/超量而跳过的图片数 */
  skippedImages: number
}

export const MAX_DOC_FILE = 20 * 1024 * 1024
export const MAX_DOC_TEXT = 6000
const MAX_IMAGES = 20
/** 小于该字节数视为项目符号/装饰图标 */
const MIN_IMAGE_BYTES = 2048

interface PickedText {
  text: string
  fullText: string
  chars: number
  truncated: boolean
}

/* ---- OOXML 命名空间 ---- */
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
}

/** JSZip 的宽松结构类型（避免引入包类型依赖） */
interface ZipLike {
  file: (p: string) => { async: (t: 'string' | 'uint8array') => Promise<unknown> } | null
  files: Record<string, unknown>
}

function parseXml(s: string): Document {
  const doc = new DOMParser().parseFromString(s, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('文档 XML 解析失败（文件可能已损坏）')
  }
  return doc
}

/** rels 关系文件 → rId → zip 内绝对路径；相对目标基于所在 part 的目录解析（处理 ../ 回退） */
function parseRels(raw: string | undefined, baseDir: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!raw) return map
  const doc = parseXml(raw)
  for (const rel of doc.getElementsByTagNameNS(REL_NS, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (!id || !target) continue
    const parts = `${baseDir}${target}`.split('/')
    const out: string[] = []
    for (const seg of parts) {
      if (seg === '..') out.pop()
      else if (seg !== '.' && seg !== '') out.push(seg)
    }
    map.set(id, out.join('/'))
  }
  return map
}

function readText(zip: ZipLike) {
  return async (p: string): Promise<string | undefined> => {
    const f = zip.file(p)
    return f ? ((await f.async('string')) as string) : undefined
  }
}

function readBytes(zip: ZipLike) {
  return async (p: string): Promise<Uint8Array | undefined> => {
    const f = zip.file(p)
    return f ? ((await f.async('uint8array')) as Uint8Array) : undefined
  }
}

/** 图片收集器：按扩展名过滤 + 去重 + 装饰图过滤 + 数量上限 */
class ImageCollector {
  images: DocImage[] = []
  skipped = 0
  private seen = new Set<string>()
  private counter = 0

  add(bytes: Uint8Array | undefined, zipPath: string, where: string): string | null {
    if (!bytes || bytes.length === 0) return null
    const ext = zipPath.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext]
    if (!mime) {
      this.skipped++
      return null
    }
    if (bytes.length < MIN_IMAGE_BYTES) {
      this.skipped++
      return null
    }
    const key = `${bytes.length}:${bytes[0]}:${bytes[1]}:${bytes.at(-2)}:${bytes.at(-1)}`
    if (this.seen.has(key)) {
      this.skipped++
      return null
    }
    if (this.images.length >= MAX_IMAGES) {
      this.skipped++
      return null
    }
    this.seen.add(key)
    this.counter++
    const id = `img${this.counter}`
    this.images.push({ id, mime, bytes, where })
    return id
  }
}

function blipRids(scope: Element | Document): string[] {
  const rids: string[] = []
  for (const blip of scope.getElementsByTagNameNS(A_NS, 'blip')) {
    const rid = blip.getAttributeNS(R_NS, 'embed')
    if (rid) rids.push(rid)
  }
  return rids
}

function truncate(text: string): PickedText {
  const chars = text.length
  if (chars <= MAX_DOC_TEXT) return { text, fullText: text, chars, truncated: false }
  return {
    text: `${text.slice(0, MAX_DOC_TEXT)}\n\n…（文档过长已截断，如需更多细节请告诉我具体部分）`,
    fullText: text,
    chars,
    truncated: true,
  }
}

/* ---------- docx ---------- */

async function parseDocx(zip: ZipLike): Promise<ParsedDoc> {
  const text = readText(zip)
  const bytes = readBytes(zip)
  const docXml = await text('word/document.xml')
  if (!docXml) throw new Error('不是有效的 Word 文档（缺少正文）')
  const doc = parseXml(docXml)
  const relsMap = parseRels(await text('word/_rels/document.xml.rels'), 'word/')

  const collector = new ImageCollector()
  const lines: string[] = []
  const paras = doc.getElementsByTagNameNS(W_NS, 'p')
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!
    const parts: string[] = []
    for (const t of p.getElementsByTagNameNS(W_NS, 't')) parts.push(t.textContent ?? '')
    const line = parts.join('')
    const imgIds: string[] = []
    for (const rid of blipRids(p)) {
      const path = relsMap.get(rid)
      if (!path) continue
      const id = collector.add(await bytes(path), path, `第${i + 1}段`)
      if (id) imgIds.push(`【${id}】`)
    }
    const merged = imgIds.length > 0 ? `${imgIds.join('')}${line}` : line
    if (merged.trim()) lines.push(merged)
  }
  const t = truncate(lines.join('\n'))
  return { kind: 'docx', ...t, images: collector.images, skippedImages: collector.skipped }
}

/* ---------- pptx ---------- */

async function parsePptx(zip: ZipLike): Promise<ParsedDoc> {
  const text = readText(zip)
  const bytes = readBytes(zip)
  const slideNums = Object.keys(zip.files)
    .map((p) => p.match(/^ppt\/slides\/slide(\d+)\.xml$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
  if (slideNums.length === 0) throw new Error('不是有效的 PPT 文档（缺少幻灯片）')

  const collector = new ImageCollector()
  const lines: string[] = []
  for (const n of slideNums) {
    const xml = await text(`ppt/slides/slide${n}.xml`)
    if (!xml) continue
    const doc = parseXml(xml)
    const relsMap = parseRels(await text(`ppt/slides/_rels/slide${n}.xml.rels`), 'ppt/slides/')
    lines.push(`--- 第${n}页 ---`)
    for (const para of doc.getElementsByTagNameNS(A_NS, 'p')) {
      const parts: string[] = []
      for (const t of para.getElementsByTagNameNS(A_NS, 't')) parts.push(t.textContent ?? '')
      const line = parts.join('')
      if (line.trim()) lines.push(line)
    }
    let imgOnSlide = 0
    for (const rid of blipRids(doc.documentElement)) {
      const path = relsMap.get(rid)
      if (!path) continue
      const id = collector.add(await bytes(path), path, `第${n}页`)
      if (id) imgOnSlide++
    }
    if (imgOnSlide > 0) lines.push(`（本页含图片 ${imgOnSlide} 张）`)
  }
  const t = truncate(lines.join('\n'))
  return { kind: 'pptx', ...t, images: collector.images, skippedImages: collector.skipped }
}

/* ---------- xlsx ---------- */

async function parseXlsx(zip: ZipLike): Promise<ParsedDoc> {
  const text = readText(zip)
  const bytes = readBytes(zip)
  // 共享字符串表
  const shared: string[] = []
  const sstXml = await text('xl/sharedStrings.xml')
  if (sstXml) {
    const sst = parseXml(sstXml)
    for (const si of sst.getElementsByTagNameNS(S_NS, 'si')) {
      let s = ''
      for (const t of si.getElementsByTagNameNS(S_NS, 't')) s += t.textContent ?? ''
      shared.push(s)
    }
  }
  // 工作表顺序与名称（来自 workbook.xml）
  const wbXml = await text('xl/workbook.xml')
  if (!wbXml) throw new Error('不是有效的 Excel 文档（缺少工作簿）')
  const wb = parseXml(wbXml)
  const relsMap = parseRels(await text('xl/_rels/workbook.xml.rels'), 'xl/')
  const sheets: { name: string; path: string }[] = []
  for (const sh of wb.getElementsByTagNameNS(S_NS, 'sheet')) {
    const name = sh.getAttribute('name') ?? 'Sheet'
    const rid = sh.getAttributeNS(R_NS, 'id')
    const path = rid ? relsMap.get(rid) : undefined
    if (path) sheets.push({ name, path })
  }
  if (sheets.length === 0) throw new Error('不是有效的 Excel 文档（缺少工作表）')

  const ROWS_PER_SHEET = 100
  const lines: string[] = []
  for (const { name, path } of sheets) {
    const xml = await text(path)
    if (!xml) continue
    lines.push(`--- 工作表 ${name} ---`)
    const sheet = parseXml(xml)
    let rowCount = 0
    for (const row of sheet.getElementsByTagNameNS(S_NS, 'row')) {
      if (rowCount >= ROWS_PER_SHEET) {
        lines.push(`（仅展示前 ${ROWS_PER_SHEET} 行）`)
        break
      }
      const cells: string[] = []
      for (const c of row.getElementsByTagNameNS(S_NS, 'c')) {
        const type = c.getAttribute('t')
        let v = ''
        if (type === 'inlineStr') {
          for (const t of c.getElementsByTagNameNS(S_NS, 't')) v += t.textContent ?? ''
        } else {
          const vEl = c.getElementsByTagNameNS(S_NS, 'v')[0]
          const rawV = vEl?.textContent ?? ''
          v = type === 's' ? (shared[Number(rawV)] ?? '') : rawV
        }
        if (v.trim()) cells.push(v.trim())
      }
      if (cells.length > 0) lines.push(cells.join(' | '))
      rowCount++
    }
  }
  // 内嵌图片（含 WPS cellimages 内嵌图，均在 media/ 下）
  const collector = new ImageCollector()
  const paths = Object.keys(zip.files).filter((p) => /^xl\/media\//.test(p))
  for (const p of paths) {
    collector.add(await bytes(p), p, '工作簿内嵌图')
  }
  const t = truncate(lines.join('\n'))
  return { kind: 'xlsx', ...t, images: collector.images, skippedImages: collector.skipped }
}

/* ---------- 入口 ---------- */

export function officeKindOf(name: string): OfficeKind | null {
  const n = name.toLowerCase()
  if (n.endsWith('.docx')) return 'docx'
  if (n.endsWith('.pptx')) return 'pptx'
  if (n.endsWith('.xlsx')) return 'xlsx'
  if (/\.(md|markdown|txt|csv)$/i.test(n)) return 'text'
  return null
}

/** 纯文本文件（md/txt/csv）→ 同构 ParsedDoc（无图片） */
export async function parseTextFile(file: File | Blob): Promise<ParsedDoc> {
  const raw = await file.text()
  const t = truncate(raw)
  return { kind: 'text', ...t, images: [], skippedImages: 0 }
}

/** 解析 Office 文档；不支持的格式抛中文 Error（含转存提示） */
export async function parseOffice(file: File | Blob, name: string): Promise<ParsedDoc> {
  const kind = officeKindOf(name)
  if (!kind) {
    if (/\.(doc|ppt|xls)$/i.test(name)) {
      throw new Error('暂不支持 97-2003 旧格式（.doc/.ppt/.xls），请用 Office/WPS 另存为 .docx/.pptx/.xlsx 后再试')
    }
    throw new Error('不支持的文档格式，仅支持 .docx / .pptx / .xlsx')
  }
  if (file.size > MAX_DOC_FILE) {
    throw new Error(`文档过大（${Math.round(file.size / 1024 / 1024)}MB），上限 20MB`)
  }
  const JSZip = (await import('jszip')).default
  const zip = (await JSZip.loadAsync(file)) as unknown as ZipLike
  if (kind === 'docx') return parseDocx(zip)
  if (kind === 'pptx') return parsePptx(zip)
  return parseXlsx(zip)
}
