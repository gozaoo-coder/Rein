/* e2e：草稿箱编辑 / 照片入聊天 / create_food / 模糊搜索 / 智能添加抽屉（mock 模式，Edge headless） */
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:1420'
let passed = 0
let failed = 0
function ok(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

// 1x1 红色 JPEG（最小合法图）
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD3+iiigD//2Q=='

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 420, height: 820 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

console.log('== 场景一：食物草稿箱点击进入编辑 ==')
await page.goto(`${BASE}/#/ai`)
await page.waitForTimeout(1200)

// 预置两条草稿（一条带 foodId、一条未匹配），走应用自己的存储 key
await page.evaluate((jpeg) => {
  localStorage.setItem(
    'rein.foodDrafts.v1',
    JSON.stringify([
      {
        id: 'fdtest1',
        createdAt: new Date().toISOString(),
        thumbBase64: jpeg,
        items: [
          { foodId: 10, foodName: '鸡蛋', grams: 60, kcalEstimate: 77, confidence: 0.9, note: null },
          { foodId: null, foodName: '杨枝甘露', grams: 300, kcalEstimate: 450, confidence: 0.9, note: null },
        ],
      },
      {
        id: 'fdtest2',
        createdAt: new Date().toISOString(),
        items: [{ foodId: null, foodName: '烤冷面', grams: 200, kcalEstimate: 500, confidence: 0.9, note: null }],
      },
    ]),
  )
}, JPEG_B64)
await page.reload()
await page.waitForTimeout(1000)

const draftChip = page.locator('button.chip', { hasText: '草稿箱' })
ok('草稿箱 chip 显示条数', (await draftChip.innerText()).includes('· 2'))
await draftChip.click()
await page.waitForTimeout(400)
ok('草稿列表弹层打开', await page.getByRole('dialog', { name: '食物草稿箱' }).isVisible())
ok('草稿行渲染两条', (await page.locator('.drow').count()) === 2)

// 关键修复点：点击草稿行必须打开编辑弹层
await page.locator('.drow').first().click()
await page.waitForTimeout(600)
const editorDialog = page.locator('.panel', { hasText: '识别到 2 项' })
ok('点击草稿后编辑弹层出现（原 bug 点）', await editorDialog.isVisible())
ok('进入可编辑态（含餐次选择与写入按钮）',
  (await editorDialog.locator('.fpr').count()) === 2 && (await editorDialog.getByText('写入今日', { exact: false }).count()) > 0)
ok('未匹配项有标记', (await editorDialog.locator('.tag', { hasText: '未匹配' }).count()) === 1)

// 行内改克重 → 草稿回写
await editorDialog.locator('button.chip', { hasText: '60g' }).click()
await editorDialog.locator('input[type=number]').fill('80')
await editorDialog.locator('input[type=number]').press('Enter')
await page.waitForTimeout(400)
const draftsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('rein.foodDrafts.v1')))
ok('克重修改回写草稿箱', draftsAfter[0]?.items?.[0]?.grams === 80, JSON.stringify(draftsAfter[0]))

// 从编辑弹层再存一份草稿 → 列表变三条
await editorDialog.locator('button.ghost', { hasText: '存草稿箱' }).click()
await page.waitForTimeout(400)
ok('存草稿后 chip 计数 +1', (await draftChip.innerText()).includes('· 3'), await draftChip.innerText())

console.log('== 场景二：选图挂附件 → 配文字发送 → 图文进聊天 ==')
const fileInput = page.locator('input[type=file]').first()
await fileInput.setInputFiles({ name: 'meal.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_B64, 'base64') })
await page.waitForTimeout(800)
ok('选图后出现附件芯片（不立即发送）', await page.locator('.attach-chip img').isVisible())
ok('未立即产生聊天消息（仍只有欢迎语）', (await page.locator('.msg').count()) === 1)
ok('placeholder 切换为带图文案',
  (await page.locator('.inbar textarea').getAttribute('placeholder')) === '问问这张图，或直接记录饮食')
const sendBtn = page.locator('button.send')
ok('有附件时发送按钮可点', await sendBtn.isEnabled())
await page.locator('.inbar textarea').fill('这个热量高吗')
await sendBtn.click()
await page.waitForTimeout(1200)
ok('发送后附件芯片清空', (await page.locator('.attach-chip').count()) === 0)
ok('照片气泡 + 随图文字气泡出现',
  (await page.locator('.photo-bubble img').count()) === 1 &&
  (await page.locator('.msg.user .bubble', { hasText: '这个热量高吗' }).count()) === 1)
const storedPhoto = await page.evaluate(() => localStorage.getItem('rein.mock.ai_chats.v1') ?? '')
ok('photo 消息带文字持久化', storedPhoto.includes('"kind":"photo"'))
ok('无模型时给出配置提示',
  (await page.locator('.bubble', { hasText: '识别图片需要先在「模型」页添加并探测 AI 模型' }).count()) > 0)

console.log('== 场景三：create_food 链路（mock 后端）+ toParsedItems 校验 ==')
const createResult = await page.evaluate(async () => {
  const { dietService } = await import('/src/services/dietService.ts')
  const first = await dietService.createFood({
    name: '杨枝甘露',
    category: '零食',
    kcal: 95,
    protein: 1.2,
    carb: 18,
    fat: 2.1,
    fiber: 0.5,
    sugar: 14,
    sodiumMg: 30,
    defaultUnit: '杯',
    units: [{ name: '杯', grams: 320 }],
  })
  const second = await dietService.createFood({
    name: '杨枝甘露', category: '零食', kcal: 95, protein: 1.2, carb: 18, fat: 2.1,
    defaultUnit: null, units: [],
  })
  const list = await dietService.listFoods('杨枝甘露', null, 10)
  const got = await dietService.getFood(first.food.id)
  return { first, secondCreated: second.created, secondId: second.food.id, listLen: list.length, gotName: got?.name }
})
ok('create_food 新建成功并返回完整 Food', createResult.first.created === true && createResult.first.food.id > 0 &&
  createResult.first.food.units[0]?.grams === 320, JSON.stringify(createResult))
ok('同名重复创建返回既有记录 created=false 同 id',
  createResult.secondCreated === false && createResult.secondId === createResult.first.food.id)
ok('list_foods / get_food 能查到新建食品', createResult.listLen >= 1 && createResult.gotName === '杨枝甘露')

const validate = await page.evaluate(async () => {
  const { dietService } = await import('/src/services/dietService.ts')
  const { toParsedItems } = await import('/src/ai/foodMatch.ts')
  const items = await toParsedItems([
    { foodName: '鸡蛋', grams: 50, kcalEstimate: 77, foodId: 10 },
    { foodName: 'e2e幻影食物', grams: 100, kcalEstimate: 120, foodId: 99999999 },
    { foodName: 'e2e缺省食物', grams: 100, kcalEstimate: 88 },
  ])
  const a = await dietService.getFood(items[1].foodId)
  const b = await dietService.getFood(items[2].foodId)
  return { ids: items.map((i) => i.foodId), aName: a?.name, aKcal: a?.kcal, bName: b?.name, bKcal: b?.kcal }
})
ok('toParsedItems：合法 id 保留，幻觉/缺省 id 自动补录（不再归 null）',
  validate.ids[0] === 10 && validate.ids[1] > 0 && validate.ids[2] > 0 &&
  validate.aName === 'e2e幻影食物' && validate.aKcal === 120 &&
  validate.bName === 'e2e缺省食物' && validate.bKcal === 88, JSON.stringify(validate))

console.log('== 场景四：食物模糊搜索（字包含 + 顺序相似度排序） ==')
const fuzzy = await page.evaluate(async () => {
  const { dietService } = await import('/src/services/dietService.ts')
  await dietService.createFood({
    name: '无糖可乐', category: '饮品', kcal: 0, protein: 0, carb: 0, fat: 0,
    defaultUnit: null, units: [],
  })
  const list = await dietService.searchFoodsFuzzy('可乐', 10)
  return { names: list.map((f) => f.name), first: list[0]?.name }
})
ok('模糊搜索「可乐」首位 =「可乐」（完全一致 100 分）', fuzzy.first === '可乐', JSON.stringify(fuzzy.names))
ok('「无糖可乐」按序命中且排在其后（适当减分）',
  fuzzy.names.indexOf('无糖可乐') >= 0 && fuzzy.names.indexOf('无糖可乐') > 0, JSON.stringify(fuzzy.names))

console.log('== 场景五：主页记饮食 → 智能添加抽屉（草稿区 + 手动食物库） ==')
await page.goto(`${BASE}/#/`)
await page.waitForTimeout(1000)
await page.locator('button.qa', { hasText: '记饮食' }).click()
await page.waitForTimeout(500)
const smart = page.locator('.panel', { hasText: '记饮食' })
ok('智能添加抽屉打开（标题 记饮食）', await smart.isVisible())
ok('粘贴区 / 识别图片 / 生成按钮齐全',
  (await smart.locator('textarea.paste').count()) === 1 &&
  (await smart.locator('button.pic', { hasText: '识别图片' }).count()) === 1 &&
  (await smart.locator('button.run', { hasText: '生成' }).count()) === 1)
ok('手动入口「从食物库选择」存在', (await smart.locator('button.manual', { hasText: '从食物库选择' }).count()) === 1)
const homeFile = page.locator('input[type=file]')
await homeFile.setInputFiles({ name: 'meal.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_B64, 'base64') })
await page.waitForTimeout(600)
ok('选图先进草稿区（附件芯片，不立即解析）', (await smart.locator('.attach-chip img').count()) === 1)
ok('未点生成前没有结果卡', (await smart.locator('.food-card').count()) === 0)
await smart.locator('button.run', { hasText: '生成' }).click()
await page.waitForTimeout(600)
ok('无模型时点生成给出配置提示', (await smart.locator('.state .err').count()) > 0)
await page.locator('.panel button[aria-label="关闭"]').click()
await page.waitForTimeout(400)

console.log('== 场景六：待办智能添加抽屉（手动填写待办入口） ==')
await page.goto(`${BASE}/#/todos`)
await page.waitForTimeout(1000)
await page.locator('button.hdr-btn[aria-label="添加待办"]').click()
await page.waitForTimeout(500)
const tsmart = page.locator('.panel', { hasText: '添加待办' })
ok('待办智能添加抽屉打开', await tsmart.isVisible())
ok('手动入口「手动填写待办」存在', (await tsmart.locator('button.manual', { hasText: '手动填写待办' }).count()) === 1)
await tsmart.locator('button.manual', { hasText: '手动填写待办' }).click()
await page.waitForTimeout(500)
ok('点手动填写 → 待办完整表单弹层出现', (await page.locator('.panel input[placeholder="要做什么？"]').count()) > 0)

// 截图留档
await page.screenshot({ path: '.zcode/shots/e2e-draft-photo-createfood-v2.png' })

await browser.close()
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
