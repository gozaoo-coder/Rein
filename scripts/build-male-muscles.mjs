/**
 * 男性体格肌群图构建：melihcolpan/MuscleMap（MIT）的 MaleFrontPaths /
 * MaleBackPaths（Swift 中的 SVG path 字符串数组）→ src/assets/muscles/male/。
 *
 * - 每视图输出 base（头/颈/手足等中性部件）+ 每 MuscleKey 一个叠加文件；
 *   全部文件共用同一 viewBox（由该视图所有路径的包围盒 + 边距计算），
 *   叠在一起恰好对齐（组件按 wger 同款分层堆叠渲染）。
 * - 坐标解释器按 SVG 规范走：命令内多段链式相对偏移都以「段起点」为基准，
 *   控制点与端点都要进入包围盒。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'src/assets/muscles/male')
fs.mkdirSync(OUT, { recursive: true })

const PAD = 24

/** 解析 path d：返回所有端点/控制点的绝对坐标（用于包围盒） */
function collectPoints(d) {
  const pts = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let cmd = null
  let abs = true
  let pending = []
  const toks = d.match(/[MmLlCcQqSsTtVvHhAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const all = [...toks, '']

  const mark = (px, py) => pts.push([px, py])
  const segStart = () => [x, y]
  const settle = () => {
    const p = pending
    pending = []
    switch (cmd) {
      case 'M': case 'm': case 'L': case 'l': {
        while (p.length >= 2) {
          const [a, b] = p.splice(0, 2)
          x = abs ? a : x + a
          y = abs ? b : y + b
          if (cmd === 'M' || cmd === 'm') {
            sx = x
            sy = y
            cmd = abs ? 'L' : 'l' // 后续隐式直线
          }
          mark(x, y)
        }
        break
      }
      case 'H': case 'h': {
        while (p.length >= 1) {
          x = abs ? p.shift() : x + p.shift()
          mark(x, y)
        }
        break
      }
      case 'V': case 'v': {
        while (p.length >= 1) {
          y = abs ? p.shift() : y + p.shift()
          mark(x, y)
        }
        break
      }
      case 'C': case 'c': case 'S': case 's': {
        while (p.length >= 6) {
          const [a, b, c2d, e2, ex, ey] = p.splice(0, 6)
          const [sx0, sy0] = segStart()
          const c1 = abs ? [a, b] : [sx0 + a, sy0 + b]
          const c2 = abs ? [c2d, e2] : [sx0 + c2d, sy0 + e2]
          const end = abs ? [ex, ey] : [sx0 + ex, sy0 + ey]
          mark(...c1)
          mark(...c2)
          mark(...end)
          x = end[0]
          y = end[1]
        }
        break
      }
      case 'Q': case 'q': case 'T': case 't': {
        while (p.length >= 4) {
          const [a, b, ex, ey] = p.splice(0, 4)
          const [sx0, sy0] = segStart()
          const c = abs ? [a, b] : [sx0 + a, sy0 + b]
          const end = abs ? [ex, ey] : [sx0 + ex, sy0 + ey]
          mark(...c)
          mark(...end)
          x = end[0]
          y = end[1]
        }
        break
      }
      case 'A': case 'a': {
        while (p.length >= 7) {
          const [, , , , , ex, ey] = p.splice(0, 7)
          const end = abs ? [ex, ey] : [x + ex, y + ey]
          mark(...end)
          x = end[0]
          y = end[1]
        }
        break
      }
      case 'Z': case 'z': {
        x = sx
        y = sy
        break
      }
      default:
        break
    }
  }

  for (const t of all) {
    if (t === '' || /^[A-Za-z]$/.test(t)) {
      settle()
      if (t !== '') {
        cmd = t
        abs = t === t.toUpperCase()
      }
      continue
    }
    pending.push(Number(t))
  }
  return pts
}

function parseSwift(src) {
  const out = {}
  // 有的部分用 left/right 数组，有的用 common（对称/单一部件，如 head/neck/feet）
  const re = /slug: \.(\w+),\s*(left: \[(.*?)\],\s*)?right: \[(.*?)\],?\s*\)|slug: \.(\w+),\s*common: \[(.*?)\]/gs
  let m
  while ((m = re.exec(src))) {
    const slug = m[1] ?? m[5]
    const paths = []
    const grab = (side) => {
      for (const mm of side.matchAll(/"((?:[^"\\]|\\.)*)"/g)) paths.push(mm[1])
    }
    if (m[3] !== undefined) grab(m[3])
    if (m[4] !== undefined) grab(m[4])
    if (m[6] !== undefined) grab(m[6])
    out[slug] = paths
  }
  return out
}

const M = parseSwift(fs.readFileSync(path.join(ROOT, 'resources/muscles/male-src/male_front.swift'), 'utf-8'))
const B = parseSwift(fs.readFileSync(path.join(ROOT, 'resources/muscles/male-src/male_back.swift'), 'utf-8'))

/** MuscleKey → slug 列表；顺序即层叠顺序，细小组件排后（后画在上层） */
const VIEWS = {
  front: {
    base: ['head', 'neck', 'hair', 'hands', 'feet', 'knees', 'ankles'],
    deltoid: ['deltoids', 'frontDeltoid'],
    chest: ['chest', 'upperChest', 'lowerChest'],
    biceps: ['biceps'],
    triceps: ['triceps'],
    forearm: ['forearm'],
    core: ['abs', 'upperAbs', 'lowerAbs', 'obliques', 'serratus'],
    traps: ['trapezius'],
    quads: ['quadriceps', 'innerQuad', 'outerQuad'],
    calves: ['calves', 'tibialis'],
    scm: ['__scm'], // 素材未含胸锁乳突肌，按颈部版式手绘（见 CUSTOM_PATHS）
  },
  back: {
    base: ['head', 'neck', 'hair', 'hands', 'feet', 'knees', 'ankles'],
    deltoid: ['deltoids', '__ddRear', '__ddMid'],
    traps: ['trapezius'],
    lats: ['upperBack'],
    triceps: ['triceps'],
    forearm: ['forearm'],
    core: ['lowerBack'],
    glutes: ['gluteal'],
    hamstrings: ['hamstring'],
    calves: ['calves'],
  },
}

/**
 * 手绘补充（源坐标系，与 swift 数据同空间，经 translate 后对齐画布）：
 * - scm：正面胸锁乳突肌两条（素材缺失）
 * - __ddRear / __ddMid：背面肩部分区——后束（肩胛冈下斜带）与
 *   中束（肩外侧弧），与 deltoids 同层同色，靠缝隙+描边显示分区
 */
const CUSTOM_PATHS = {
  scm: [
    'M306 174C302 200 310 228 321 253L336 250C326 226 320 198 322 171Z',
    'M389 174C393 200 385 228 374 253L359 250C369 226 375 198 373 171Z',
  ],
  __ddRear: [
    'M956 364Q980 334 1010 340L1010 354Q982 350 962 376Z',
    'M1251 364Q1227 334 1197 340L1197 354Q1225 350 1245 376Z',
  ],
  __ddMid: [
    'M1018 316Q1036 330 1038 354L1026 356Q1024 332 1008 322Z',
    'M1189 316Q1171 330 1169 354L1181 356Q1183 332 1199 322Z',
  ],
}

/** 视图级包围盒：必须对「该视图全部文件」共用，保证层间对齐 */
function boundsOf(allSlugs, data) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of allSlugs) {
    for (const d of data[s] ?? []) {
      for (const [px, py] of collectPoints(d)) {
        minX = Math.min(minX, px)
        minY = Math.min(minY, py)
        maxX = Math.max(maxX, px)
        maxY = Math.max(maxY, py)
      }
    }
  }
  return { minX, minY, maxX, maxY }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** 两视图在同一全局画布（正面前排/背面右排）：各自归一化到原点，
 *  再统一 viewBox 尺寸（取两视图最大值），保证正面/背面渲染比例一致 */
const views = {}
for (const [view, groups] of Object.entries(VIEWS)) {
  const data = view === 'front' ? M : B
  const allSlugs = [...new Set(Object.values(groups).flat())]
  views[view] = { data, groups, ...boundsOf(allSlugs, data) }
}

const W = Math.max(...Object.values(views).map((v) => v.maxX - v.minX)) + PAD * 2
const H = Math.max(...Object.values(views).map((v) => v.maxY - v.minY)) + PAD * 2
const VB = `${W.toFixed(1)} ${H.toFixed(1)}`

for (const [view, { data, groups, minX, minY }] of Object.entries(views)) {
  const tx = -minX + PAD
  const ty = -minY + PAD
  for (const [key, slugs] of Object.entries(groups)) {
    const inner = slugs
      .map((slug) => {
        const paths = CUSTOM_PATHS[slug] ?? data[slug] ?? []
        return paths.map((d) => `<path d="${esc(d)}"/>`).join('\n')
      })
      .join('\n')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB}">\n<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)})">\n${inner}\n</g>\n</svg>\n`
    fs.writeFileSync(path.join(OUT, `${view}-${key}.svg`), svg)
    console.log(`${view}-${key}.svg  ${(svg.length / 1024).toFixed(1)} KB  vb=${VB}`)
  }
}
console.log('done →', OUT)