/**
 * 极简安全 Markdown 渲染（AI 输出专用，零依赖）。
 *
 * 支持围栏代码块（```）、表格（GFM 分隔行）、行内代码、粗体、斜体、无序/有序列表、
 * 引用行、标题行（降级为粗体）、段内换行。输入先整体 HTML 转义再按白名单替换，
 * 不信任模型输出。
 *
 * 流式渲染约定（与 streamExtract「行完整才产出」同哲学）：splitBlocks 按 \n\n 分块
 * （围栏内不切），调用方（MdText）缓存已完成块、只重渲末尾未完块，避免整段重排闪烁；
 * 未闭合的代码块按普通段落显示，闭合后升格为 <pre>；分隔行还没到的表格先按普通
 * 段落显示，到达后升格为 <table>（判据是「下一行是不是分隔行」，不猜）。
 */

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 行内规则：行内代码 → 粗体 → 斜体（输入必须是已转义文本） */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
}

/* ---------- 表格（GFM：表头行 + 分隔行 + 数据行） ---------- */

/** 列对齐：:--- 左、:---: 中、---: 右、--- 缺省左 */
type ColAlign = 'left' | 'center' | 'right'

/** 按未转义的 `|` 切分一行；首尾的裸竖线（GFM 可省略）不当内容 */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? ''
    // `\|` 是内容里的竖线（模型描述「A | B」时这么写），不当分隔符
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function alignOf(cell: string): ColAlign {
  const t = cell.trim()
  if (t.startsWith(':') && t.endsWith(':')) return 'center'
  if (t.endsWith(':')) return 'right'
  return 'left'
}

/** 分隔行：每个单元都是 `-` / `:-` / `-:` / `:-:`（至少一个连字符） */
function isDelimRow(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-')) return false
  const cells = splitRow(t)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

/** 一行是不是表格行：含竖线即可（数据行不要求有分隔行那种严格形态） */
function isRow(line: string): boolean {
  return line.includes('|')
}

/** 渲染一张表。列数以表头为准：多出来的单元格丢弃、缺的补空（与 GFM 一致） */
function renderTable(head: string[], align: ColAlign[], rows: string[][]): string {
  const cols = head.length
  const cell = (tag: 'th' | 'td', text: string, i: number): string =>
    `<${tag} style="text-align:${align[i] ?? 'left'}">${renderInline(escapeHtml(text))}</${tag}>`
  const headHtml = `<tr>${head.map((h, i) => cell('th', h, i)).join('')}</tr>`
  const bodyHtml = rows
    .map((r) => `<tr>${Array.from({ length: cols }, (_, i) => cell('td', r[i] ?? '', i)).join('')}</tr>`)
    .join('')
  // 外层 wrap 负责横向滚动：窄屏（手机气泡）里宽表不撑破气泡，改为表内滚动
  return `<div class="md-table-wrap"><table class="md-table"><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`
}

/** 按 \n\n 分块；``` 围栏内部不切分 */
export function splitBlocks(src: string): string[] {
  const lines = src.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let fence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && line.trim() === '' && cur.length > 0) {
      blocks.push(cur.join('\n'))
      cur = []
      continue
    }
    cur.push(line)
  }
  if (cur.length > 0) blocks.push(cur.join('\n'))
  return blocks
}

/** 渲染一个块（含未闭合围栏的降级处理） */
export function renderBlock(block: string): string {
  const lines = block.split('\n')
  // 围栏代码块：``` 开头即视为代码块（流式中未闭合也按代码块渲染，避免闪烁）
  if (lines[0]?.trimStart().startsWith('```')) {
    const inner = lines.slice(1)
    if (inner.length > 0 && /^\s*```\s*$/.test(inner[inner.length - 1] ?? '')) inner.pop()
    return `<pre class="md-pre"><code>${escapeHtml(inner.join('\n'))}</code></pre>`
  }
  const out: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  const flushList = (): void => {
    if (!list) return
    out.push(list.kind === 'ul' ? `<ul>${list.items.map((i) => `<li>${i}</li>`).join('')}</ul>` : `<ol>${list.items.map((i) => `<li>${i}</li>`).join('')}</ol>`)
    list = null
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? ''
    const t = line.trim()
    // 表格：本行含竖线 + 下一行是分隔行。分隔行没到之前（流式中）按普通段落走，
    // 到了就升格 —— 先给的原始文本不会被「猜」成表格。
    if (isRow(t) && isDelimRow(lines[li + 1] ?? '')) {
      flushList()
      const head = splitRow(t)
      const align = splitRow(lines[li + 1] ?? '').map(alignOf)
      const rows: string[][] = []
      let ri = li + 2
      for (; ri < lines.length && isRow(lines[ri] ?? ''); ri++) rows.push(splitRow(lines[ri] ?? ''))
      out.push(renderTable(head, align, rows))
      li = ri - 1
      continue
    }
    const ul = t.match(/^[-*]\s+(.*)$/)
    const ol = t.match(/^(\d+)[.、]\s+(.*)$/)
    if (ul) {
      if (!list || list.kind !== 'ul') {
        flushList()
        list = { kind: 'ul', items: [] }
      }
      list.items.push(renderInline(escapeHtml(ul[1] ?? '')))
      continue
    }
    if (ol) {
      if (!list || list.kind !== 'ol') {
        flushList()
        list = { kind: 'ol', items: [] }
      }
      list.items.push(renderInline(escapeHtml(ol[2] ?? '')))
      continue
    }
    flushList()
    if (!t) continue
    const h = t.match(/^#{1,6}\s+(.*)$/)
    if (h) {
      out.push(`<p class="md-h"><b>${renderInline(escapeHtml(h[1] ?? ''))}</b></p>`)
      continue
    }
    if (t.startsWith('>')) {
      out.push(`<p class="md-quote">${renderInline(escapeHtml(t.replace(/^>\s?/, '')))}</p>`)
      continue
    }
    out.push(`<p>${renderInline(escapeHtml(t))}</p>`)
  }
  flushList()
  return out.join('')
}

/** 全量渲染（非流式定稿用） */
export function renderMarkdown(src: string): string {
  return splitBlocks(src).map(renderBlock).join('')
}
