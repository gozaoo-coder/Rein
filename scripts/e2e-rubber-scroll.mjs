/* 验证：自绘超范围回弹 · 页面级（mock + Edge headless + CDP 触摸仿真）。
 * A 顶部下拉：平移量符合对数阻尼曲线 f(x)=k·ln(1+x/k)（k=1/ln(衰减指数)，见 src/system/rubberScroll.ts）
 * B 20px 小位移近 1:1（f'(0)=1），平均速率随位移递减（越拖越沉）
 * C 反向拖回：越过 overOffset=0 立即清 transform、原生滚动接管（交接无跳变）
 * D 松手：弹簧回位后 transform 清空
 * E 页中拖动：不接管（transform 恒空、原生滚动正常）
 * F band 期间 TabBar 纹丝不动（只平移页面层）
 */
import { chromium } from 'playwright-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = 'http://127.0.0.1:1420'

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
await page.waitForSelector('[data-rubber-page]', { state: 'attached' })
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

const layer = () =>
  page.locator('[data-rubber-page]').evaluate((el) => {
    const cs = getComputedStyle(el).transform
    return { ty: cs === 'none' ? 0 : new DOMMatrixReadOnly(cs).m42, raw: el.style.transform }
  })
const scrollY = () => page.evaluate(() => window.scrollY)
const toTop = () => page.evaluate(() => window.scrollTo(0, 0))

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
