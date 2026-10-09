/* 验证：自绘超范围回弹 · 页面级（mock + Edge headless + CDP 触摸仿真）。
 * A 顶部下拉：平移量符合对数阻尼曲线 f(x)=k·ln(1+x/k)（k=1/ln(衰减指数)，见 src/system/rubberScroll.ts）
 * B 20px 小位移近 1:1（f'(0)=1），平均速率随位移递减（越拖越沉）
 * C 反向拖回：越过 overOffset=0 立即清 transform、原生滚动接管（交接无跳变）
 * D 松手：弹簧回位后 transform 清空
 * E 页中拖动：不接管（transform 恒空、原生滚动正常）
 * F band 期间 TabBar 纹丝不动（只平移页面层）
 * G 内层容器（首页画布时间轴，内容层 .inner）
 * H 横向条（版式对照页 pill 导航，自平移 x 轴）
 * I 页面级 band 走「容器不动、只内容动」：页头全程纹丝不动（顶边/底边各一遍），
 *   且从原生滚动切入超伸的瞬间平移量恰好等于手指越边行程（无多余 offset），
 *   松手弹簧归位后页头回到原处
 */
import { chromium } from 'playwright-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 与其它 e2e 同一条约定：本机 1420 被划进保留端口段时用 REIN_E2E_URL 指向别的实例 */
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:1420'

/* 与 src/system/rubberScroll.ts 的 DECAY_BASE 同步；调参后这里也要改 */
const DECAY_BASE = 1.02
const K = 1 / Math.log(DECAY_BASE)
const f = (x) => K * Math.log1p(x / K)

let failed = 0
function ok(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed++
}

async function dismissUpdate(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('.up-card button')].find((x) => x.textContent.trim() === '稍后')
    if (b) b.click()
    return !!b
  })
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({
  viewport: { width: 420, height: 820 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })

await page.goto(`${BASE}/#/`)
await page.waitForSelector('[data-rubber-shell]', { state: 'attached' })
await page.waitForTimeout(1400) // 等静默更新检查把提示卡弹出来（它带全屏遮罩，挡触摸）
await dismissUpdate(page)
await page.waitForTimeout(300)

const send = (type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  })

/** 分帧慢拖（每帧 10ms，接近真机慢拖的速度量级） */
async function drag(x0, y0, x1, y1, steps = 4) {
  await send('touchStart', x0, y0)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await send('touchMove', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
    await page.waitForTimeout(10)
  }
}

/** 页面级平移层：页面把「页头之后的内容」挂成内容层（.page > .rubber-layer），
 *  容器框与吸顶页头留在层外（system/rubberScroll 的 layerFor 解析）。 */
const layer = () =>
  page.locator('.page > .rubber-layer').evaluate((el) => {
    const cs = getComputedStyle(el).transform
    return { ty: cs === 'none' ? 0 : new DOMMatrixReadOnly(cs).m42, raw: el.style.transform }
  })
const headerTop = () =>
  page.locator('.page-header').first().evaluate((el) => el.getBoundingClientRect().top)
const scrollY = () => page.evaluate(() => window.scrollY)
const toTop = () => page.evaluate(() => window.scrollTo(0, 0))

/** 记录页面收到的每一个 touch 事件的 clientY 与当时的平移量（喂给 I 组断言）。
 *  监听器挂在模块自己的监听之后注册：同一事件上它排后面跑，读到的就是本模块
 *  刚写下的 transform。band 的越边行程以「送达过的坐标」为基准 —— 浏览器吞掉的
 *  move 不越边，不算进 over。 */
await page.evaluate(() => {
  window.__trace = []
  const layer = () => document.querySelector('.page > .rubber-layer')
  const ty = () => {
    const cs = getComputedStyle(layer()).transform
    return cs === 'none' ? 0 : new DOMMatrixReadOnly(cs).m42
  }
  window.addEventListener('touchstart', (e) => {
    window.__trace = [{ y: e.touches[0]?.clientY ?? 0, ty: ty(), start: true }]
  })
  window.addEventListener('touchmove', (e) => {
    window.__trace.push({ y: e.touches[0]?.clientY ?? 0, ty: ty() })
  })
})
const trace = () => page.evaluate(() => window.__trace.slice())
const moves = () => page.evaluate(() => window.__moves.slice())

/**
 * 选一个「纯页面内容」落点：从该点向上到 body 之间没有可滚动的祖先、
 * 也没有 touch-action:none（否则手势被内层容器 / 自管手势子树接管——
 * 这不是页面级 band 的场景）。
 */
const pickPlainY = () =>
  page.evaluate(() => {
    for (let y = 80; y < 620; y += 20) {
      let n = document.elementFromPoint(210, y)
      let plain = true
      while (n && n !== document.body) {
        const cs = getComputedStyle(n)
        if (cs.touchAction === 'none') plain = false
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) plain = false
        if (!plain) break
        n = n.parentElement
      }
      if (plain) return y
    }
    return -1
  })

/* ---------- A/B/F：页首下拉 ---------- */
await toTop()
await page.waitForTimeout(120)
const X = 210
const Y = await pickPlainY()
ok('S0 找到纯页面内容落点', Y > 0, `y=${Y}`)
const tabBefore = await page.locator('.dock').boundingBox()

await drag(X, Y, X, Y + 20, 4) // 下拉 20px
const at20 = await layer()
await send('touchMove', X, Y + 60) // 继续拉到 60px
await page.waitForTimeout(40)
const at60 = await layer()
const tabDuring = await page.locator('.dock').boundingBox()

ok(
  'A1 下拉 20px 出现平移且近 1:1（f(20)）',
  Math.abs(at20.ty - f(20)) < 1.5,
  `ty=${at20.ty.toFixed(2)} 期望 ${f(20).toFixed(2)}`,
)
ok(
  'A2 下拉 60px 符合对数阻尼（f(60)）',
  Math.abs(at60.ty - f(60)) < 2,
  `ty=${at60.ty.toFixed(2)} 期望 ${f(60).toFixed(2)}`,
)
ok(
  'A3 平均速率递减（越拖越沉）',
  at60.ty / 60 < at20.ty / 20,
  `${(at60.ty / 60).toFixed(3)} < ${(at20.ty / 20).toFixed(3)}`,
)
ok('A4 越界期间页面本身不滚动', (await scrollY()) === 0, `scrollY=${await scrollY()}`)
ok(
  'F1 band 期间 TabBar 纹丝不动',
  tabBefore.x === tabDuring.x && tabBefore.y === tabDuring.y,
  JSON.stringify({ before: tabBefore, during: tabDuring }),
)

/* ---------- C：反向拖回，越过 0 之后交还原生 ---------- */
await send('touchMove', X, Y) // 回到起点：overOffset=0
await page.waitForTimeout(40)
const back0 = await layer()
await send('touchMove', X, Y - 60) // 再往上 60px：应当由原生滚动接管（扣浏览器 slop）
await page.waitForTimeout(80)
const afterNative = await layer()
const sy = await scrollY()
await send('touchEnd', 0, 0)
ok(
  'C1 拖回边界 transform 立即清空',
  back0.raw === '' && Math.abs(back0.ty) < 0.01,
  `raw="${back0.raw}" ty=${back0.ty}`,
)
ok('C2 越过边界后原生滚动接管', afterNative.raw === '' && sy > 10, `scrollY=${sy}`)

/* ---------- D：按住保持、松手弹簧回位 ---------- */
await toTop()
await page.waitForTimeout(120)
await drag(X, Y, X, Y + 40, 8) // 下拉 40px 保持按住
const at40 = await layer()
ok(
  'D1 按住时保持平移（f(40)）',
  Math.abs(at40.ty - f(40)) < 2,
  `ty=${at40.ty.toFixed(2)} 期望 ${f(40).toFixed(2)}`,
)
await send('touchEnd', 0, 0)
await page.waitForTimeout(800)
const settled = await layer()
ok(
  'D2 松手后弹簧回位并清空',
  settled.raw === '' && Math.abs(settled.ty) < 0.01,
  `raw="${settled.raw}" ty=${settled.ty}`,
)

/* ---------- I：容器不动、只内容动 + 切入超伸无跳变 ----------
   页面把页头之后的内容挂成内容层（.page > .rubber-layer）：容器框与吸顶页头留在
   层外，band 全程只有内容位移。老实现把整页（含 sticky 页头）当层，滚到边缘切入
   超伸的瞬间页头会跟着内容一起被拽走 —— 即「异常地额外 offset 一下」。 */
{
  const X = 210
  const Y = 300

  /** 慢拖 count 步、每步步长 step；返回 {ys, tys, hdrs, sys} 逐步快照 */
  async function stepDrag(dy, count, step) {
    await send('touchStart', X, Y)
    const ys = []
    const tys = []
    const hdrs = []
    const sys = []
    for (let i = 1; i <= count; i++) {
      const y = Y + dy * i * step
      await send('touchMove', X, y)
      await page.waitForTimeout(14)
      ys.push(y)
      tys.push((await layer()).ty)
      hdrs.push(await headerTop())
      sys.push(await scrollY())
    }
    return { ys, tys, hdrs, sys }
  }

  /** 从轨迹里核对：平移量恰为 dy·f(越边行程)（dy=1 下拉 / -1 上拖），不能多跳 */
  function checkEdge(name, tr, dy) {
    const firstBand = tr.findIndex((p) => !p.start && Math.abs(p.ty) > 0.05)
    ok(`${name} 出现超伸`, firstBand >= 1, `首次平移在第 ${firstBand + 1} 个送达事件`)
    if (firstBand < 1) return
    const base = tr[firstBand - 1].y
    let worst = 0
    for (let j = firstBand; j < tr.length; j++) {
      const over = Math.abs(tr[j].y - base)
      worst = Math.max(worst, Math.abs(tr[j].ty - dy * f(over)))
    }
    ok(`${name} 平移量 = f(手指越边行程)，无多余 offset`, worst < 1.5, `最大偏差 ${worst.toFixed(2)}px`)
  }

  /* ---- 底边：滚到底后向上拖过底边 ---- */
  const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
  await page.evaluate((m) => window.scrollTo(0, m), max)
  await page.waitForTimeout(200)
  const hb = await headerTop()
  const syB = await scrollY()
  ok('I0a 滚到底后页头钉在视口顶', hb === 0, `header.top=${hb}`)
  const bottom = await stepDrag(-1, 6, 8)
  await send('touchEnd', 0, 0)
  await page.waitForTimeout(900)
  ok(
    'I1a 底边超伸全程页头纹丝不动',
    bottom.hdrs.every((h) => Math.abs(h - hb) < 0.5),
    `页头: ${bottom.hdrs.map((h) => h.toFixed(1)).join(', ')}（基准 ${hb}）`,
  )
  ok(
    'I2a 底边超伸期间页面本身不滚动',
    bottom.sys.every((s) => s === syB),
    `scrollY: ${bottom.sys.join(', ')}`,
  )
  checkEdge('I3a 底边', await trace(), -1)
  const afterBottom = await layer()
  ok(
    'I4a 松手弹簧归位、页头回原处',
    afterBottom.raw === '' && Math.abs((await headerTop()) - hb) < 0.5,
    `raw="${afterBottom.raw}" header.top=${(await headerTop()).toFixed(1)}`,
  )

  /* ---- 顶边：回顶部后向下拖过顶边 ---- */
  await toTop()
  await page.waitForTimeout(200)
  const hb2 = await headerTop()
  const syT = await scrollY()
  const top = await stepDrag(1, 6, 8)
  await send('touchEnd', 0, 0)
  await page.waitForTimeout(900)
  ok(
    'I1b 顶边超伸全程页头纹丝不动',
    top.hdrs.every((h) => Math.abs(h - hb2) < 0.5),
    `页头: ${top.hdrs.map((h) => h.toFixed(1)).join(', ')}（基准 ${hb2}）`,
  )
  ok(
    'I2b 顶边超伸期间页面本身不滚动',
    top.sys.every((s) => s === syT),
    `scrollY: ${top.sys.join(', ')}`,
  )
  checkEdge('I3b 顶边', await trace(), 1)
  const afterTop = await layer()
  ok(
    'I4b 松手弹簧归位、页头回原处',
    afterTop.raw === '' && Math.abs((await headerTop()) - hb2) < 0.5,
    `raw="${afterTop.raw}" header.top=${(await headerTop()).toFixed(1)}`,
  )
}

/* ---------- E：页中拖动不接管 ---------- */
await page.evaluate(() => window.scrollTo(0, 200))
await page.waitForTimeout(120)
const Y2 = await pickPlainY()
const midY = Y2 > 0 ? Y2 + 40 : 300
await drag(X, midY, X, midY + 60, 6)
const mid = await layer()
const midScroll = await scrollY()
await send('touchEnd', 0, 0)
ok('E1 页中拖动不接管（transform 恒空）', mid.raw === '', `raw="${mid.raw}"`)
ok('E2 页中拖动原生滚动正常', midScroll < 200 && midScroll > 100, `scrollY=${midScroll}（期望 ≈140）`)

/* ---------- G：内层容器（首页画布时间轴，内容层 .inner） ----------
 * 该容器带 overscroll-behavior:contain：滚动链在它这里截断，
 * 到边后应由它自己接管（平移 .inner），页面层不动。 */
await page.evaluate(() => window.scrollTo(0, 0))
await page.waitForTimeout(120)
const canvasBox = await page.locator('[data-testid="canvas-scroll"]').boundingBox()
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="canvas-scroll"]')
  if (el) el.scrollTop = 0
})
await page.waitForTimeout(60)
const cx = canvasBox.x + canvasBox.width / 2
const cy = canvasBox.y + canvasBox.height - 30
await drag(cx, cy, cx, cy + 60, 6)
const inner = await page.locator('[data-testid="canvas-scroll"] .inner').evaluate((el) => {
  const cs = getComputedStyle(el).transform
  return { ty: cs === 'none' ? 0 : new DOMMatrixReadOnly(cs).m42, raw: el.style.transform }
})
const outerG = await layer()
await send('touchEnd', 0, 0)
ok(
  'G1 内层容器到边：内容层自平移（f(60)）',
  Math.abs(inner.ty - f(60)) < 2.5,
  `ty=${inner.ty.toFixed(2)} 期望 ${f(60).toFixed(2)}`,
)
ok('G2 内层接管时页面层不动', outerG.raw === '', `raw="${outerG.raw}"`)

/* ---------- H：横向条（版式对照页 pill 导航，自平移 x 轴） ---------- */
await page.goto(`${BASE}/#/voice-layouts`)
await page.waitForSelector('.pills', { state: 'attached' })
await page.waitForTimeout(400)
const pillsBox = await page.locator('.pills').boundingBox()
await page.evaluate(() => {
  const el = document.querySelector('.pills')
  if (el) el.scrollLeft = 0
})
await page.waitForTimeout(60)
const pxx = pillsBox.x + 60
const pyy = pillsBox.y + pillsBox.height / 2
await drag(pxx, pyy, pxx + 60, pyy, 6) // 手指右拉：越过左端
const pills = await page.locator('.pills').evaluate((el) => {
  const cs = getComputedStyle(el).transform
  return { tx: cs === 'none' ? 0 : new DOMMatrixReadOnly(cs).m41, raw: el.style.transform }
})
await send('touchEnd', 0, 0)
ok(
  'H1 横向条到边：自平移 x 轴（f(60)）',
  Math.abs(pills.tx - f(60)) < 2.5,
  `tx=${pills.tx.toFixed(2)} 期望 ${f(60).toFixed(2)}`,
)

await browser.close()
console.log(failed === 0 ? '== 全部通过 ==' : `== 失败 ${failed} 项 ==`)
process.exit(failed === 0 ? 0 : 1)
