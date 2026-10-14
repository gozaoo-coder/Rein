/**
 * 桌面度量的共用实现 —— 探针（probe-desktop-audit.mjs）和验收守卫（e2e-desktop-audit.mjs）
 * 用同一份页面内度量函数，避免两边各写一份后判据漂移。
 *
 * measureInPage 会被 page.evaluate 序列化到页面里执行，所以它必须是自包含的纯函数：
 * 不引用模块作用域的任何东西（字面量阈值在函数体内重新声明）。
 */

/** 页面内的度量：一次 evaluate 把七类都量出来，返回结构化 JSON（在页面里执行，必须自包含） */
function measureInPage() {
  const MIN_TAP = 24
  const MIN_FS = 11
  const MAX_REPORT = 12
  const vw = window.innerWidth
  const vh = window.innerHeight

  /** 元素的可读选路符：标签 + 类名 + 序号，最多三级，用于人肉定位 */
  const path = (el) => {
    const parts = []
    let node = el
    for (let i = 0; i < 3 && node && node.nodeType === 1; i += 1) {
      let s = node.tagName.toLowerCase()
      const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/).filter(Boolean)
      if (cls.length) s += '.' + cls.slice(0, 3).join('.')
      const parent = node.parentElement
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(node) + 1})`
      }
      parts.unshift(s)
      node = node.parentElement
      if (node && (node.tagName === 'BODY' || node.id)) break
    }
    return parts.join(' > ')
  }
  const visible = (el) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    if (r.bottom < -vh || r.top > vh * 2) return false // 离屏很远的（滚不出视口的层）不算
    return true
  }
  /**
   * 装饰层与被设计成 mask 的玻璃件要排除：.glow-layer 是玻璃的辉光底、dock 的流光丸
   * 之类本来就该被裁；沉浸层（.session-layer）常驻挂载、靠位移藏起来。
   * 不排除的话，「被裁」这一栏永远是这些系统件刷屏，真内容缺陷被淹掉。
   */
  const skipTree = (el) => {
    let p = el
    while (p && p !== document.body) {
      if (p.getAttribute?.('aria-hidden') === 'true' || p.hasAttribute?.('inert')) return true
      const cls = typeof p.className === 'string' ? p.className : ''
      if (/glow-layer|session-layer|session-page|dock-assembly|glass-surface/.test(cls)) return true
      if (p.tagName === 'SVG' || p.tagName === 'PATH') return true
      p = p.parentElement
    }
    return false
  }
  const rect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })

  const out = {
    viewport: { w: vw, h: vh },
    url: location.hash,
    shell: document.documentElement.dataset.shell ?? '',
    inspector: document.documentElement.dataset.inspector ?? '',
    docScrollW: document.documentElement.scrollWidth,
    overflowX: document.documentElement.scrollWidth - vw,
    hasDesk: !!document.querySelector('.desk-main'),
    hasTabBar: !!document.querySelector('.tabbar, .dock, [class*="tabbar"]'),
    contentWidth: 0,
    padX: getComputedStyle(document.documentElement).getPropertyValue('--page-pad-x').trim(),
    overflowEls: [],
    clipped: [],
    smallTap: [],
    tinyFont: [],
    hScrollBoxes: 0,
    gutterRatio: 0,
    paint: null,
    error: null,
  }

  // 内容栏宽（壳层观感）：取页面里最外层的 .page 或 main 的实测宽
  const pageEl = document.querySelector('.desk-main .page, .app-frame .page, .page')
  if (pageEl) out.contentWidth = Math.round(pageEl.getBoundingClientRect().width)

  // 1 横向溢出：只找可见且越界的元素，取最右边的若干个（越界最严重的最可能真有问题）
  const offenders = []
  const all = Array.from(document.querySelectorAll('body *')).filter((el) => !skipTree(el))
  for (const el of all) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right > vw + 1 || r.left < -1) {
      // 祖先里已经有会横向滚动的容器时，这个越界是「设计内」的，不算
      let inScroll = false
      let p = el.parentElement
      while (p && p !== document.body) {
        const cs = getComputedStyle(p)
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) { inScroll = true; break }
        p = p.parentElement
      }
      if (!inScroll) offenders.push({ path: path(el), rect: rect(r), right: Math.round(r.right), tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 60) })
    }
  }
  offenders.sort((a, b) => b.right - a.right)
  out.overflowEls = offenders.slice(0, MAX_REPORT)

  // 2 真实裁切：被 overflow:hidden 的祖先切掉（auto/scroll 的祖先能滚到，不算缺陷；
  //    文本省略号也归 hidden，但那是设计内的截断 —— 只报「元素整体越界」那类）
  const clips = []
  for (const el of all) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    let p = el.parentElement
    let depth = 0
    while (p && p !== document.body && depth < 12) {
      const cs = getComputedStyle(p)
      const hx = cs.overflowX === 'hidden'
      const hy = cs.overflowY === 'hidden'
      if (hx || hy) {
        // 平移面（.scroll > .inner 这类由 JS 位移的轨道、时间刻度盘）不算裁切：那是有意为之的观感。
        // 判据看裁剪容器自己与其上溯几层：类名像轨道 / 任一环有 transform 就跳过。
        let q = p
        let hops = 0
        let panned = cs.transform !== 'none'
        while (!panned && q && q !== document.body && hops < 5) {
          const clsQ = typeof q.className === 'string' ? q.className : ''
          if (/scroll|pan|track|rail|cwrap|cgrid|tlwrap|hcanvas|canvas|\bctl\b/.test(clsQ)) panned = true
          if (getComputedStyle(q).transform !== 'none') panned = true
          q = q.parentElement
          hops += 1
        }
        if (panned) break
        const pr = p.getBoundingClientRect()
        const cut = Math.min(
          hx ? Math.max(0, pr.right - r.right, r.left - pr.left) : Number.POSITIVE_INFINITY,
          hy ? Math.max(0, pr.bottom - r.bottom, r.top - pr.top) : Number.POSITIVE_INFINITY,
        )
        if (Number.isFinite(cut) && cut > 2) {
          const text = (el.textContent || '').trim().slice(0, 50)
          // 纯文本被省略号截断（单行、有 text-overflow）是设计内的，跳过
          const isEllipsis = el.childNodes.length === 1 && el.firstChild?.nodeType === 3 && getComputedStyle(el).textOverflow !== 'clip' && r.height < 30
          if (!isEllipsis) clips.push({ path: path(el), clipBy: path(p), cut: Math.round(cut), overflow: cs.overflow, rect: rect(r), text })
        }
        break
      }
      p = p.parentElement
      depth += 1
    }
  }
  clips.sort((a, b) => b.cut - a.cut)
  out.clipped = clips.slice(0, MAX_REPORT)

  // 3 点击靶：可见交互元素任一边小于 MIN_TAP
  const taps = []
  for (const el of document.querySelectorAll('button, a, [role="button"], input, select, textarea, label[for]')) {
    if (!visible(el) || el.hasAttribute('disabled')) continue
    const r = el.getBoundingClientRect()
    if (r.width > 400 || r.height > 400) continue // 大体量容器不算
    if (r.width < MIN_TAP || r.height < MIN_TAP) taps.push({ path: path(el), rect: rect(r), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40) })
  }
  taps.sort((a, b) => Math.min(a.rect.w, a.rect.h) - Math.min(b.rect.w, b.rect.h))
  out.smallTap = taps.slice(0, MAX_REPORT)

  // 4 过小正文：有文本且 font-size < MIN_FS
  const tiny = []
  for (const el of all) {
    if (!visible(el)) continue
    const text = (el.childNodes.length === 1 && el.firstChild && el.firstChild.nodeType === 3) ? (el.textContent || '').trim() : ''
    if (!text) continue
    const fs = parseFloat(getComputedStyle(el).fontSize)
    if (fs < MIN_FS) tiny.push({ path: path(el), fs, text: text.slice(0, 40) })
  }
  tiny.sort((a, b) => a.fs - b.fs)
  out.tinyFont = tiny.slice(0, MAX_REPORT)

  // 6 横向滚动容器计数
  for (const el of all) {
    const cs = getComputedStyle(el)
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4 && visible(el)) out.hScrollBoxes += 1
  }

  // 7 视觉语言的分布：圆角 / 阴影 / 字号各用了多少种值（值种数多 = 令牌漂移；
  //   「大圆角 + 大模糊阴影」是 AI 味的典型特征，这里把量摆出来而不是靠感觉说）
  const hist = (map, key, el) => {
    const v = getComputedStyle(el)[key]
    if (!v || v === 'none' || v === '0px' || v === 'normal') return
    map[v] = (map[v] || 0) + 1
  }
  const radius = {}
  const shadow = {}
  const fs = {}
  const longLines = []
  for (const el of all) {
    if (!visible(el)) continue
    hist(radius, 'borderRadius', el)
    hist(shadow, 'boxShadow', el)
    hist(fs, 'fontSize', el)
    // 长行：**叶子级**正文块（不含块级子元素，否则量到的是整段容器的拼接文本）；
    // 每行字数按 0.9em 估（这份界面以中文为主，全角字宽约 1em）
    const isText = /^(P|LI|DIV|SPAN|TD)$/.test(el.tagName)
    if (isText) {
      const hasBlockChild = Array.from(el.children).some((c) => {
        const d = getComputedStyle(c).display
        return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item'
      })
      const text = (el.textContent || '').trim()
      const r = el.getBoundingClientRect()
      const size = parseFloat(getComputedStyle(el).fontSize)
      if (!hasBlockChild && text.length > 60 && r.width > 400 && size > 0) {
        const charsPerLine = Math.round(r.width / (size * 0.9))
        if (charsPerLine > 80) longLines.push({ path: path(el), charsPerLine, width: Math.round(r.width), chars: text.length, text: text.slice(0, 40) })
      }
    }
  }
  const top = (map) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, MAX_REPORT).map(([v, n]) => ({ v, n }))
  out.paint = {
    radius: top(radius), radiusKinds: Object.keys(radius).length,
    shadow: top(shadow), shadowKinds: Object.keys(shadow).length,
    fs: top(fs), fsKinds: Object.keys(fs).length,
    longLines: longLines.slice(0, MAX_REPORT),
  }
  out.gutterRatio = vw > 0 ? Math.round(((vw - out.contentWidth) / vw) * 100) : 0

  return out
}

export { measureInPage }
