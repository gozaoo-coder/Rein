/**
 * 无头 Edge + 原生 CDP 的 E2E 驱动（浏览器 mock 模式）。
 * 运行：node scripts/e2e-cdp.mjs
 *
 * 前置：npm run dev 已在 1420 端口；Edge 路径见 EDGE。
 * 结构：launch() 拉起无头 Edge → CDP 连第一个页面 → evalJS 驱动 UI → 断言汇总退出码。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 目标应用地址：默认共享 dev（1420）；并发会话在改同一服务时可 REIN_E2E_URL=http://localhost:1421 指向独立实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
/** 每次运行独立目录：上次运行的 Edge 残留进程会锁住旧目录（EPERM） */
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}`

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

/** 取一个当前空闲的调试端口：9333 可能被其他 Edge 实例（并行会话）占用，
 * 端口被占时 spawn 不报错但 /json 连到的是别人的实例——必须换随机端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

let DEBUG_PORT = 9333

const results = []
let ws
let msgId = 0
const pending = new Map()

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到表达式为真，超时抛错 */
async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 点击包含指定文本的按钮（在 scope 选择器内找） */
async function clickButton(text, scope = 'body') {
  return evalJS(`(() => {
    const els = [...document.querySelectorAll('${scope} button, ${scope} [role="tab"]')]
    const el = els.find(b => b.textContent.includes(${JSON.stringify(text)}) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

/** 点击并确认效果：聚焦日菜单等晚返回的 IPC 会让 Vue 换分支重排兄弟节点，
 * 点击可能落在已分离节点上被吞掉——点击 → 等效果 → 超时再点，直到生效。 */
async function clickUntil(text, waitExpr, timeoutMs = 12000, label = text) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await clickButton(text)
    try {
      await waitFor(waitExpr, 2000, label)
      return true
    } catch { /* 效果未出现，重试 */ }
  }
  throw new Error(`点击未生效: ${label}`)
}

/** 禁用全部 CSS 过渡/动画：无头下 out-in 页面过渡偶发停在 leave-from（延迟 IPC 重渲染顶掉
 * 离开节点，transitionend 永不触发），Vue 检测 0 时长会立即完成切换——e2e 只验逻辑与渲染。 */
async function injectStableCSS() {
  await evalJS(`(() => {
    let s = document.getElementById('__e2e-stable')
    if (!s) {
      s = document.createElement('style')
      s.id = '__e2e-stable'
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
      document.head.appendChild(s)
    }
    if (!window.__errsInited) {
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push(String(e.message)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)))
      window.__errsInited = true
    }
    return true
  })()`)
}

async function goto(hash, h1Text) {
  await evalJS(`location.hash = '${hash}'`)
  await sleep(400)
  if (!h1Text) return
  // 无头下 out-in 过渡可能卡死（离开组件在 leave 窗口内被延迟 IPC 的重渲染顶掉节点，
  // transitionend 永不触发）：以目标页 h1 挂载为准，卡住则重载直接挂载路由
  const t0 = Date.now()
  let landed = false
  while (Date.now() - t0 < 6000) {
    await sleep(400)
    landed = await evalJS(`document.querySelector('h1')?.textContent === ${JSON.stringify(h1Text)}`)
    if (landed) return
  }
  console.log(`  [诊断] 过渡卡住（→ ${hash}），重载恢复`)
  await cdp('Page.reload')
  await injectStableCSS()
  await waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(h1Text)}`, 15000, `挂载 ${hash}`)
}

async function connect(pageTargetUrl) {
  // 先开空白页拿到 target，再显式导航并等加载完成
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      p.resolve(m.result ?? m.error)
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  // 无头渲染器按需出帧，rAF 可能长期不入队 → Vue 过渡停在 page-leave-from。
  // 启动持续截屏强制合成器连续出帧（不取图，仅保帧率）。
  await cdp('Page.startScreencast', { format: 'jpeg', everyNthFrame: 1 }).catch(() => undefined)
  await cdp('Page.navigate', { url: pageTargetUrl })
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
  await injectStableCSS()
}

/** 点击指定标签的 NumberStepper 的增/减按钮（label 文本定位，避免顺序耦合） */
async function bumpStepper(labelText, dir = '增加', times = 1) {
  for (let i = 0; i < times; i++) {
    await evalJS(`(() => {
      const st = [...document.querySelectorAll('.stepper')].find(s => s.textContent.includes(${JSON.stringify(labelText)}))
      if (!st) return false
      const btn = [...st.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(dir)})
      btn.click()
      return true
    })()`)
    await sleep(150)
  }
}

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    // 无头下 rAF 会被节流：Vue out-in 过渡停在 page-leave-from 永不进入 leave-to，页面切换卡死
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=430,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/`)
    // 注入错误收集器后重载，保证捕获整个应用生命周期的异常
    await cdp('Page.enable')
    await cdp('Page.reload')
    await injectStableCSS()
    await sleep(1200)
    await evalJS(`(() => {
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push(String(e.message)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)))
      return true
    })()`)

    /* ---------- N. 主页（状态条+时间线+常用工具栏）与二级页返回键 ---------- */
    await sleep(600)
    ok('N1 常用工具栏含 ≥5 个工具格（含健康方案）', await evalJS(
      `document.querySelectorAll('.tools .tool').length >= 5 &&
       [...document.querySelectorAll('.tools .tool')].some(c => c.textContent.includes('健康方案'))`,
    ))
    ok('N1b 状态条与主页画布渲染', await evalJS(
      `!!document.querySelector('.strip .rings') && !!document.querySelector('[data-testid="home-canvas"] .ctl')`,
    ))
    ok('N1b2 画布时间轴结构', await evalJS(
      `!!document.querySelector('[data-testid="home-canvas"] .scroll')`,
    ))
    // 点「记饮食」工具格应弹出智能添加抽屉
    await evalJS(`[...document.querySelectorAll('.tools .tool')].find(c => c.textContent.includes('记饮食'))?.click()`)
    await sleep(900)
    ok('N2 记饮食工具格弹出抽屉', await evalJS(
      `[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '关闭' || b.textContent.trim() === '关闭')`,
    ))
    await evalJS(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '关闭' || b.textContent.trim() === '关闭')?.click()`)
    await sleep(500)
    await evalJS(`location.hash = '#/program'`)
    await sleep(600)
    ok('N3 二级页有返回键', await evalJS(`!!document.querySelector('.page-header .back')`))
    await evalJS(`document.querySelector('.page-header .back').click()`)
    await sleep(500)
    ok('N4 返回键回主页', await evalJS(`!location.hash.includes('/program')`))
    await evalJS(`location.hash = '#/me'`)
    await sleep(500)

    /* ---------- A. 我页 · 个人约束 ---------- */
    await waitFor(`location.hash.includes('/me')`)
    ok('A1 我页加载且约束卡存在', await evalJS(
      `[...document.querySelectorAll('h2')].some(h => h.textContent.includes('个人约束'))`,
    ))
    const summary0 = await evalJS(`[...document.querySelectorAll('.clist b')].map(b => b.textContent).join('/')`)
    ok('A2 默认摘要展示', typeof summary0 === 'string' && summary0.includes('天'), summary0)

    // 打开编辑抽屉
    await clickButton('编辑')
    await waitFor(`[...document.querySelectorAll('.__sheet, .sheet, [class*=panel]')].length > 0 || [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存')`, 4000, '编辑抽屉出现')
    ok('A3 编辑抽屉打开（含保存按钮）', await evalJS(
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存')`,
    ))

    // 训练频率 3 → 5（按步进器标签定位；受控组件需等重渲染再点下一次）
    await bumpStepper('每周训练', '增加', 2)
    // 身高体重顺手改掉（验证新加的身体数据编辑）
    await bumpStepper('身高', '减少', 5)
    await bumpStepper('体重', '增加', 8)
    // 运动时段：默认已选晚间，改点早晨 + 午间
    ok('A3b 时段切换', (await clickButton('早晨', 'div')) && (await clickButton('午间', 'div')))
    // 器械切「居家徒手」（segmented 第二项）
    ok('A4 器械分段切换', await clickButton('居家徒手'))
    // 身体数据（方案计算硬前置）：性别男 + 生日
    ok('A4b 性别选择', await clickButton('男'))
    await evalJS(`(() => {
      const inp = document.querySelector('.cform input[type="date"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(inp, '1995-06-15')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 忌口添加两项
    for (const kw of ['海鲜', '花生']) {
      await evalJS(`(() => {
        const inp = document.querySelector('.rinput')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(inp, ${JSON.stringify(kw)})
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await clickButton('添加')
      await sleep(100)
    }
    ok('A5 忌口 chips 已加两条', await evalJS(
      `[...document.querySelectorAll('.chips .chip')].filter(c => /×/.test(c.textContent)).length === 2`,
    ))
    await clickButton('保存')
    await sleep(600)
    const sumText = () => evalJS(`[...document.querySelectorAll('.clist b')].map(b => b.textContent).join('/')`)
    const s1 = await sumText()
    ok('A6 保存后摘要更新（5天/时段/居家/忌口2项）',
      s1.includes('5 天') && s1.includes('早晨') && s1.includes('午间') && s1.includes('居家徒手') && s1.includes('海鲜、花生'), s1)

    /* ---------- B. 方案页 · 约束向导 + 三档对比矩阵 + 强度预览 ---------- */
    // ProfilePage 重构后 /me 不再有「健康方案」跳转钮，直接 hash 跳转（与 N3 同方式）
    await evalJS(`location.hash = '#/program'`)
    await waitFor(`location.hash.includes('/program')`, 3000, '路由跳转')
    await waitFor(`[...document.querySelectorAll('.pod-head b')].some(b => b.textContent.includes('定制你的方案'))`, 5000, '约束向导渲染')
    ok('B1 方案页进入 setup 态（内联约束向导）', true)

    const preview0 = await evalJS(`document.querySelector('.pv-value')?.textContent ?? ''`)
    ok('B1b 约束即时预览（继承我页约束）', preview0.includes('5 练') && preview0.includes('居家徒手'), preview0)

    ok('B1c 约束 chips 可点（6 天）', await clickButton('6 天', '.pod'))
    await waitFor(`!!document.querySelector('.warn-note')`, 2000, '高频提醒')
    ok('B1d 6 练当场给出恢复提醒', true)
    await clickButton('5 天', '.pod')

    await clickButton('计算三套方案')
    await waitFor(`!!document.querySelector('.matrix')`, 15000, '对比矩阵渲染')
    ok('B2 三档对比矩阵渲染', true)

    const headTiers = await evalJS(`[...document.querySelectorAll('.matrix thead th')].map(t => t.textContent.trim()).join('/')`)
    ok('B3 三档列名正确且无不可用', /保守/.test(headTiers) && /均衡/.test(headTiers) && /进取/.test(headTiers) && !headTiers.includes('不可用'), headTiers)

    const kcals = await evalJS(`[...document.querySelectorAll('.matrix tbody tr')[0].querySelectorAll('td')].slice(1).map(td => Number(td.textContent))`)
    ok('B4 热量单调（保守>均衡>进取）', kcals[0] > kcals[1] && kcals[1] > kcals[2] && kcals.every((k) => k > 800), kcals.join('>'))

    const daysVals = await evalJS(`[...document.querySelectorAll('.matrix tbody tr')].find(tr => tr.textContent.includes('每周训练')).textContent.match(/\\d+天/g).join(',')`)
    ok('B4b 训练频率按用户设置（三档同频 5 天）', daysVals === '5天,5天,5天', daysVals)

    ok('B4c 月度预期行（结果行加重）', await evalJS(
      `[...document.querySelectorAll('.matrix tbody tr')].some(tr => tr.textContent.includes('预计月变化') && tr.textContent.includes('kg'))`,
    ))

    // 点列选中：差异解说实时改写
    await evalJS(`[...document.querySelectorAll('.matrix thead .col-hit')].find(b => b.textContent.includes('均衡')).click()`)
    await sleep(300)
    const diffText = await evalJS(`[...document.querySelectorAll('.pod')].find(p => p.textContent.includes('差在哪'))?.textContent ?? ''`)
    ok('B5 点列选中 → 差异解说更新', diffText.includes('均衡 vs 进取') && diffText.includes('大卡'), diffText.slice(0, 70))

    // 02 强度预览：28 格 + 周时长 + 节奏卡 + 档位 chips
    await evalJS(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.includes('强度预览'))?.click()`)
    await sleep(400)
    const loadCells = await evalJS(`document.querySelectorAll('.grid .cell').length`)
    ok('B6 强度预览 28 格', loadCells === 28, String(loadCells))
    ok('B6b 节奏解说出现', await evalJS(`[...document.querySelectorAll('.pod')].some(p => p.textContent.includes('强度节奏'))`))
    ok('B6c 预览内 chips 切到进取', await clickButton('进取', '.tier-pick'))
    await sleep(250)
    ok('B6d 周行数 4（表头 + 4 周）', await evalJS(`document.querySelectorAll('.grid .week-row').length === 5`))
    ok('B6e 切回均衡', await clickButton('均衡', '.tier-pick'))
    await evalJS(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.includes('参数对比'))?.click()`)
    await sleep(300)

    // 11 科学依据弹层（三条研究曲线；08-30 频次语义修正后 setup 入口文案随之更新）
    ok('B7 科学依据入口可点', await clickButton('看研究曲线'))
    await waitFor(`!!document.querySelector('.chart')`, 4000, '曲线图渲染')
    ok('B7b 曲线 tab 三项可切', await evalJS(`document.querySelectorAll('[role="tab"]').length >= 3`))
    ok('B7c 档位要点表渲染', await evalJS(`[...document.querySelectorAll('.rows li')].some(li => li.textContent.includes('次/周'))`))
    await evalJS(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '明白了')?.click()`)
    await sleep(400)

    // 启用均衡
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('启用「均衡」方案'))`, 3000, '启用按钮')
    await clickButton('启用「均衡」方案')
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认启用')`, 3000, '确认抽屉')
    ok('B8 启用确认抽屉说明日程写入', await evalJS(
      `[...document.querySelectorAll('p,li')].some(p => p.textContent.includes('写入日程表'))`,
    ))
    await clickButton('确认启用')
    await waitFor(`!!document.querySelector('.cockpit')`, 15000, 'active 态驾驶舱渲染')

    /* ---------- C. 生效态（驾驶舱/罗盘/菜单/地图/航道） ---------- */
    /* C0 页头 ⋯ → ActionSheet（成绩单/归档/删除收纳） */
    await evalJS(`document.querySelector('.hdr-btn')?.click()`)
    await waitFor(`[...document.querySelectorAll('.card-wrap .opt')].some(o => o.textContent.includes('删除方案'))`, 6000, '更多菜单')
    ok('C0 ⋯ 菜单含 归档/删除', await evalJS(
      `(() => { const t = document.body.textContent; const okMenu = t.includes('归档方案') && t.includes('删除方案'); document.querySelector('.opt.cancel')?.click(); return okMenu })()`,
    ))

    const headText = await evalJS(`document.querySelector('.head-strip').textContent`)
    ok('C1 状态条显示 减脂·v1·第1周，参数详情含 4餐5练', /减脂/.test(headText) && /4餐5练/.test(headText) && headText.includes('v1') && /第 1 周/.test(headText), headText.slice(0, 70))
    await evalJS(`document.querySelector('.strip')?.click()`)
    await sleep(500)
    ok('C1b 状态条展开参数四格', await evalJS(
      `!!document.querySelector('.strip-detail.open .stats') && document.querySelectorAll('.strip-detail .stats li').length === 4`,
    ))
    ok('C2 驾驶舱三环 + 三条执行进度', await evalJS(
      `!!document.querySelector('.cockpit svg') && document.querySelectorAll('.bar-row').length === 3`,
    ))
    ok('C2b 今日训练动作行（含课程名）', await evalJS(
      `!!document.querySelector('.action-title') && document.querySelector('.action-title').textContent.length > 0`,
    ), await evalJS(`document.querySelector('.action-title')?.textContent`))
    ok('C3 下一餐并入驾驶舱（餐次+菜名+记一笔）', await evalJS(
      `!!document.querySelector('.nm-slot') && document.querySelector('.nm-slot').textContent.includes('下一餐') && !!document.querySelector('.nm-name')`,
    ), await evalJS(`document.querySelector('.nm-slot')?.textContent`))
    ok('C4 未生成回落模板菜单并提示', await evalJS(
      `!!document.querySelector('.menu-fallback') && document.querySelectorAll('.menu li').length >= 3`,
    ))
    ok('C4b 忌口过滤生效（无清蒸鱼）', await evalJS(
      `![...document.querySelectorAll('.menu li')].some(li => li.textContent.includes('清蒸鱼'))`,
    ))
    await clickUntil('AI 生成这一天的菜单', `!!document.querySelector('.ai-err') || !!document.querySelector('.ai-tag')`, 10000, 'AI 菜单错误提示')
    ok('C4c 无模型时按天生成给出可读错误', await evalJS(
      `document.body.textContent.includes('未配置 AI 模型')`,
    ))

    /* C4d 记一笔 → 智能添加（food 模式）→ 手动从食物库选择 → 落库 */
    const mealsBefore = await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const meals = await invoke('list_meals', { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) })
      return meals.length
    })()`)
    await evalJS(`document.querySelector('.mini')?.click()`)
    await waitFor(`[...document.querySelectorAll('.panel')].some(p => p.textContent.includes('记饮食'))`, 6000, '记饮食抽屉')
    ok('C4d 记一笔打开智能添加（food 模式）', true)
    await evalJS(`document.querySelector('.panel .manual')?.click()`)
    await waitFor(`!!document.querySelector('.list .item')`, 6000, '食物库列表')
    await evalJS(`document.querySelector('.list .item')?.click()`)
    await sleep(500)
    await evalJS(`[...document.querySelectorAll('.panel button')].find(b => b.textContent.includes('加入'))?.click()`)
    await sleep(1200)
    ok('C4d2 食物库选择写入成功', await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const meals = await invoke('list_meals', { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) })
      return meals.length > ${mealsBefore}
    })()`))
    ok('C4d3 菜单卡记一笔仅聚焦今天展示（当前聚焦未来日，不应出现）', await evalJS(
      `![...document.querySelectorAll('.linkbtn')].some(b => b.textContent.includes('＋ 记一笔'))`,
    ))

    /* ---------- S. 本周采购清单（无模型 → 全模板菜单聚合路径） ---------- */
    await clickUntil('本周采购清单', `!!document.querySelector('.shop-list li')`, 8000, '采购清单弹层')
    ok('S1 弹层展示范围与天数', await evalJS(
      `!!document.querySelector('.shop-note') && /天/.test(document.querySelector('.shop-note').textContent)`,
    ), await evalJS(`document.querySelector('.shop-note')?.textContent`))
    ok('S2 按分类分组（≥2 组）', await evalJS(
      `document.querySelectorAll('.shop-group').length >= 2`,
    ), await evalJS(`[...document.querySelectorAll('.shop-group .g-name')].map(g => g.textContent).join('、')`))
    ok('S3 行含数量与天数注记', await evalJS(
      `[...document.querySelectorAll('.shop-list li')].length > 0 &&
       [...document.querySelectorAll('.shop-list li')].every(li => li.querySelector('.s-amt').textContent.trim().length > 0 && /天/.test(li.querySelector('.s-days').textContent))`,
    ))
    ok('S4 模板菜单校准提示', await evalJS(`!!document.querySelector('.shop-hint')`))
    await clickButton('复制全文')
    await waitFor(`document.querySelector('.shop-copy')?.textContent.includes('已复制')`, 4000, '复制反馈')
    ok('S5 复制成功反馈', true)
    // 勾选第一行 → done 态 + 清空按钮出现 → 清空恢复（走 shopping_check_set/clear IPC）
    await evalJS(`document.querySelector('.shop-list .s-row')?.click()`)
    await waitFor(`!!document.querySelector('.s-row.done') && !!document.querySelector('.shop-head .linkbtn')`, 6000, '勾选生效')
    ok('S6 勾选行划线并出现清空按钮', true)
    await evalJS(`document.querySelector('.shop-head .linkbtn')?.click()`)
    await waitFor(`!document.querySelector('.s-row.done') && !document.querySelector('.shop-head .linkbtn')`, 6000, '清空勾选')
    ok('S7 清空勾选恢复', true)
    // SheetModal 是 fixed 面板：点 panel 内的 close 关闭（CDP Esc 在无头下关不掉）
    await evalJS(`document.querySelector('.shop-list')?.closest('.panel')?.querySelector('.close')?.click()`)
    await waitFor(`!document.querySelector('.shop-list')`, 4000, '弹层关闭')

    // 06 今日菜单（罗盘与全天菜单合并后的单卡；卡题=今日菜单或聚焦日期，故按结构断言）
    ok('C5 今日菜单卡（供能结构三行 + 餐次列表）', await evalJS(
      `document.querySelectorAll('.macro-row').length === 3 && document.querySelectorAll('.menu li').length >= 3 && [...document.querySelectorAll('.pill')].some(p => p.textContent === '训练日' || p.textContent === '休息日')`,
    ))
    ok('C5b 供能解读文案', await evalJS(`[...document.querySelectorAll('.verdict')].some(v => v.textContent.includes('蛋白供能'))`))
    ok('C5c 蛋白目标对照刻度', await evalJS(`!!document.querySelector('.ptarget-track')`))

    // 05 周期地图
    const mapCells = await evalJS(`document.querySelectorAll('.grid .cell').length`)
    ok('C6 周期地图 28 格', mapCells === 28, String(mapCells))
    ok('C6b 地图统计四项', await evalJS(
      `[...document.querySelectorAll('.pod')].find(p => p.textContent.includes('周期地图'))?.querySelectorAll('.stats li').length === 4`,
    ))
    await evalJS(`[...document.querySelectorAll('.pod')].find(p => p.textContent.includes('周期地图')).querySelector('.cell').click()`)
    await sleep(400)
    ok('C6c 点格子把菜单卡切到该日（标题变日期）', await evalJS(
      `[...document.querySelectorAll('.pod-head b')].some(b => /\\d+月\\d+日 周./.test(b.textContent))`,
    ))

    // 08 体重航道
    ok('C7 体重航道（走廊 + 判定）', await evalJS(
      `[...document.querySelectorAll('.pod')].some(p => p.textContent.includes('目标走廊')) &&
       ([...document.querySelectorAll('.pod')].some(p => p.textContent.includes('航道内')) || [...document.querySelectorAll('.pod')].some(p => p.textContent.includes('需要留意')))`,
    ))

    /* ---------- D. 待办联动（新待办页默认画布视图只看今天，方案日程从下周一起，切「清单」看全量） ---------- */
    await goto('/todos')
    // 待办页 h1 是日期，用分段控件作为挂载标志；过渡卡住则重载
    let onTodos = await evalJS(`!!document.querySelector('[data-testid="seg-list"]')`)
    const dT0 = Date.now()
    while (!onTodos && Date.now() - dT0 < 6000) {
      await sleep(500)
      onTodos = await evalJS(`!!document.querySelector('[data-testid="seg-list"]')`)
    }
    if (!onTodos) {
      console.log('  [诊断] 过渡卡住（→ /todos），重载恢复')
      await cdp('Page.reload')
      await injectStableCSS()
      await waitFor(`!!document.querySelector('[data-testid="seg-list"]')`, 15000, '挂载 /todos')
    }
    await sleep(900)
    await evalJS(`document.querySelector('[data-testid="seg-list"]')?.click()`)
    let d1 = false
    try {
      await waitFor(`document.body.textContent.includes('方案饮食')`, 8000, '清单视图方案条目')
      d1 = true
    } catch { /* 断言里给出失败详情 */ }
    ok('D1 全部待办页含方案条目', d1)

    /* ---------- E. 手动调参 + 参数演进图 ---------- */
    await goto('/program', '健康方案')
    // 生效态操作区：若 store 竞态导致误入 setup，重载恢复
    let actsReady = await evalJS(`!!document.querySelector('.acts')`)
    const aT0 = Date.now()
    while (!actsReady && Date.now() - aT0 < 10000) {
      await sleep(500)
      actsReady = await evalJS(`!!document.querySelector('.acts')`)
    }
    if (!actsReady) {
      if (await evalJS(`[...document.querySelectorAll('.pod-head b')].some(b => b.textContent.includes('定制你的方案'))`)) {
        console.log('  [诊断] 方案页误入 setup（store 竞态），重载恢复')
        await cdp('Page.reload')
        await injectStableCSS()
      }
      await waitFor(`!!document.querySelector('.acts')`, 20000, '生效态操作区就绪')
    }
    await clickUntil('手动调参', `[...document.querySelectorAll('button')].some(b => b.textContent.includes('应用并重排今日起的日程'))`, 12000, '调参抽屉')
    // 缺口 -400 → 点两次减少 → -500；蛋白 +0.1；天数不变
    await bumpStepper('每日热量偏移', '减少', 2)
    await bumpStepper('蛋白质', '增加', 1)
    await sleep(150)
    await clickButton('应用并重排今日起的日程')
    await waitFor(`!!document.querySelector('.records')`, 15000, '参数演进图出现')
    const recText = await evalJS(`document.querySelector('.records').textContent`)
    ok('E1 演进图记录含 v2 与 -400 → -500', recText.includes('v2') && recText.includes('-400') && recText.includes('-500'), recText.slice(0, 90))
    ok('E2 状态条版本升到 v2', await evalJS(`/v2/.test(document.querySelector('.head-strip .grow').textContent)`), await evalJS(`document.querySelector('.head-strip .grow')?.textContent`))
    ok('E3 演进图双泳道 + 图例', await evalJS(
      `document.querySelectorAll('.chart polyline').length >= 2 && !!document.querySelector('.legend')`,
    ))
    // 点最后一个真实调整节点看 diff（首个 .node 是无变更的「起点」种子点，按设计不展开）
    await evalJS(`[...document.querySelectorAll('.chart .node')].at(-1).dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(300)
    ok('E4 点节点显示 diff（before → after）', await evalJS(
      `!!document.querySelector('.diff') && document.querySelector('.diff').textContent.includes('→')`,
    ), await evalJS(`document.querySelector('.diff')?.textContent.slice(0, 60) ?? '(无 diff)'`))

    /* ---------- F. AI 复盘错误路径（无模型配置） ---------- */
    await clickUntil('AI 本周复盘', `!!document.querySelector('.review')`, 12000, '复盘抽屉打开')
    await waitFor(
      `!!document.querySelector('.err') || !!document.querySelector('.diag')`,
      15000,
      '复盘终态出现',
    )
    const errText = await evalJS(`document.querySelector('.err')?.textContent ?? ''`)
    ok('F1 无模型时给出可读错误', errText.includes('未配置'), errText || '(空)')

    /* ---------- G. 归档 → 结营成绩单 → 再生成 → 删除 ---------- */
    // 关闭复盘抽屉（CDP Esc 在无头下关不掉弹层；弹层不关会卡住 out-in 页面过渡）
    for (let attempt = 1; attempt <= 4; attempt++) {
      const hit = await evalJS(`(() => {
        const review = document.querySelector('.review')
        if (!review) return 'not-open'
        // 多层弹层可能叠加：用 closest('.panel') 锁定复盘弹层自己的关闭钮
        const btn = review.closest('.panel')?.querySelector('.close')
        if (!btn) return 'no-x'
        btn.click()
        return 'clicked-x'
      })()`)
      await sleep(900)
      const still = await evalJS(`!!document.querySelector('.review')`)
      if (!still) break
      console.log(`  [诊断] 关闭第 ${attempt} 次: hit=${hit}, 仍开着, candidates=` + await evalJS(
        `JSON.stringify([...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === '关闭' || b.textContent.trim() === '关闭').map(b => ({ label: b.getAttribute('aria-label'), op: b.offsetParent === null })))`,
      ))
    }
    await waitFor(`!document.querySelector('.review') && !document.querySelector('.err')`, 5000, '复盘抽屉关闭')
    await sleep(300)
    await clickUntil('归档方案', `[...document.querySelectorAll('.pod-head b')].some(b => b.textContent.includes('定制你的方案'))`, 15000, '回到 setup')
    ok('G1 归档后回 setup 态', true)

    // 结营成绩单
    ok('G5 历史方案区出现', await evalJS(
      `[...document.querySelectorAll('h2')].some(h => h.textContent.includes('历史方案'))`,
    ))
    await clickUntil('结营成绩单', `location.hash.includes('/program/wrapup/')`, 8000, '成绩单路由')
    // 过渡卡死兜底：以成绩单页 h1 挂载为准，卡住则重载直接挂载路由
    let onWrapup = await evalJS(`document.querySelector('h1')?.textContent === '结营成绩单'`)
    const wT0 = Date.now()
    while (!onWrapup && Date.now() - wT0 < 6000) {
      await sleep(500)
      onWrapup = await evalJS(`document.querySelector('h1')?.textContent === '结营成绩单'`)
    }
    if (!onWrapup) {
      console.log('  [诊断] 过渡卡住，重载挂载成绩单')
      await cdp('Page.reload')
      await injectStableCSS()
      await waitFor(`document.querySelector('h1')?.textContent === '结营成绩单'`, 15000, '成绩单页挂载')
    }
    await waitFor(`!!document.querySelector('.ring') || document.body.textContent.includes('没有找到这份方案')`, 20000, '成绩单数据加载')
    if (!(await evalJS(`!!document.querySelector('.ring')`))) {
      // '没有找到'：正常流程不会发生，多为 reload 竞态下 store 未就绪——重载重试一次
      console.log('  [诊断] 成绩单未找到记录，重载重试')
      await cdp('Page.reload')
      await injectStableCSS()
      await waitFor(`!!document.querySelector('.ring') || document.body.textContent.includes('没有找到这份方案')`, 20000, '成绩单数据加载2')
    }
    console.log('  [诊断] wrapup 现场: ' + await evalJS(`JSON.stringify({ h1: document.querySelector('h1')?.textContent, ring: !!document.querySelector('.ring'), body: document.body.textContent.replace(/\s+/g, ' ').slice(0, 150), errs: window.__errs ?? null })`))
    ok('G6 成绩单完成度环 + 开始→结束对照', await evalJS(
      `!!document.querySelector('.ring') && document.body.textContent.includes('开始 → 结束')`,
    ))
    ok('G6b 完整报告 + 下一期建议', await evalJS(
      `document.body.textContent.includes('完整报告') && document.body.textContent.includes('下一期建议')`,
    ))
    ok('G6c 英雄区统计四格', await evalJS(`document.querySelectorAll('.statgrid li').length === 4`))
    await evalJS(`document.querySelector('.page-header .back').click()`)
    // 返回同样可能撞上过渡卡住：以方案页 h1 挂载为准，卡住重载
    let backOk = await evalJS(`location.hash.endsWith('/program') && document.querySelector('h1')?.textContent === '健康方案'`)
    const bT0 = Date.now()
    while (!backOk && Date.now() - bT0 < 6000) {
      await sleep(500)
      backOk = await evalJS(`location.hash.endsWith('/program') && document.querySelector('h1')?.textContent === '健康方案'`)
    }
    if (!backOk) {
      console.log('  [诊断] 返回过渡卡住，重载恢复')
      await cdp('Page.reload')
      await injectStableCSS()
      await waitFor(`location.hash.endsWith('/program') && document.querySelector('h1')?.textContent === '健康方案'`, 15000, '方案页挂载')
    }
    ok('G6d 返回方案页', true)

    // 再生成并激活进取档（约束卡 v-if 挂在 profile 加载之后，先等它出现）
    await waitFor(`[...document.querySelectorAll('.pod-head b')].some(b => b.textContent.includes('定制你的方案'))`, 8000, '约束卡就绪')
    ok('G2a 生成入口可点', await clickButton('计算三套方案'))
    await waitFor(`!!document.querySelector('.matrix')`, 15000, '再次生成')
    await evalJS(`[...document.querySelectorAll('.matrix thead .col-hit')].find(b => b.textContent.includes('进取')).click()`)
    await sleep(250)
    await clickUntil('启用「进取」方案', `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认启用')`, 10000, '进取确认抽屉')
    await clickUntil('确认启用', `!!document.querySelector('.cockpit')`, 20000, '进取激活完成')
    ok('G2 换档激活成功（进取）', await evalJS(
      `document.querySelector('.head-strip').textContent.includes('进取')`,
    ))

    // 两段式删除
    await clickButton('删除方案')
    await sleep(200)
    ok('G3 删除需二次确认', await evalJS(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('再点一次确认删除'))`,
    ))
    await clickButton('再点一次确认删除')
    await waitFor(`[...document.querySelectorAll('.pod-head b')].some(b => b.textContent.includes('定制你的方案'))`, 6000, '删除后回 setup')
    ok('G4 删除后回 setup', true)

    /* ---------- H. 回归抽查其它页面不崩 ---------- */
    for (const [hash, keyword, h1] of [
      ['/nutrition', '能量', '营养全览'],
      ['/sports', '训练', '运动'],
      ['/ai', 'AI', 'AI'],
      ['/focus', '番茄', '专注'],
      ['/ledger', '预算', '记账'],
    ]) {
      await goto(hash, h1)
      await sleep(700)
      const bodyText = await evalJS(`document.body.textContent`)
      ok(`H 回归 ${hash}（含「${keyword}」）`, bodyText.includes(keyword))
    }

    /* ---------- R. 食谱库 ---------- */
    await goto('/nutrition/recipes', '食谱库')
    await sleep(700)
    ok('R1 食谱库渲染 22 个模板', await evalJS(`document.querySelectorAll('.rlist .rrow').length === 22`))
    await evalJS(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === '午餐')?.click()`)
    await sleep(300)
    ok('R2 餐次过滤生效', await evalJS(
      `document.querySelectorAll('.rlist .rrow').length === 6 &&
       [...document.querySelectorAll('.rrow')].every(r => r.textContent.includes('午餐'))`,
    ))
    // 喜欢 → 按钮态翻转
    await evalJS(`document.querySelector('.rrow .pf')?.click()`)
    await sleep(300)
    ok('R3 喜欢标记生效', await evalJS(
      `document.querySelector('.rrow .pf')?.className.includes('on')`,
    ))
    // AI 定制错误路径（无模型）
    await clickButton('生成')
    await waitFor(`document.body.textContent.includes('未配置 AI 模型')`, 6000, 'AI 错误提示')
    ok('R4 无模型时 AI 定制给出可读错误', true)
    await evalJS(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '关闭' || b.textContent.trim() === '关闭')?.click()`)
    await sleep(400)

    const errs = await evalJS('window.__errs ?? null')
    // null = 中途 reload 丢失收集器（不计失败）；有收集结果时必须为空数组
    ok('Z 全程无未捕获异常', errs === null || (Array.isArray(errs) && errs.length === 0), JSON.stringify(errs ?? 'collector-lost').slice(0, 300))
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 中断:', e.message)
  process.exit(2)
})
