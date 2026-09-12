/**
 * 极简安全 Markdown 渲染（AI 输出专用，零依赖）。
 *
 * 支持围栏代码块（```）、行内代码、粗体、斜体、无序/有序列表、引用行、标题行（降级为粗体）、
 * 段内换行。输入先整体 HTML 转义再按白名单替换，不信任模型输出。
 *
 * 流式渲染约定（与 streamExtract「行完整才产出」同哲学）：splitBlocks 按 \n\n 分块
 * （围栏内不切），调用方（MdText）缓存已完成块、只重渲末尾未完块，避免整段重排闪烁；
 * 未闭合的代码块按普通段落显示，闭合后升格为 <pre>。
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
  for (const line of lines) {
    const t = line.trim()
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
