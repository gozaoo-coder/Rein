/**
 * 生成肌群激活图三视图（front / back / side）。
 *
 * 几何全部来自 BodyParts3D 4.0 的真实人体解剖网格（见 scripts/anatomy/taxonomy.mjs），
 * 不再是手绘控制点：正交投影 → 栅格化 → 等值线追踪 → 路径简化，
 * 因此三视图比例一致、肌缝位置来自真实解剖。
 *
 * 层叠用画家算法：每个分区按「观察深度」排序，远的先画。
 * 深层肌群同样被画出来，只是被浅层盖住 —— 隐去浅层即可看到，
 * 这就是 data-depth 与 data-layer 的用途。
 *
 * 前置：node scripts/fetch-anatomy.mjs
 * 用法：node scripts/build-anatomy.mjs
 * 输出：src/assets/muscles/rein/{front,back,side}.svg
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {MUSCLE_MESHES, FILLER_MESHES, BASE_MESHES, DEEP_KEYS} from './anatomy/taxonomy.mjs'
import {
  parseObj,
  projectMesh,
  rasterize,
  rasterizeToGrid,
  combine,
  traceContours,
  simplify,
  polygonArea,
  ringsToPath,
  VIEWS,
} from './anatomy/geometry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MESH_DIR = join(ROOT, 'resources', 'anatomy', 'meshes')
const OUT_DIR = join(ROOT, 'src/assets/muscles/rein')

const VIEWBOX_W = 660
const VIEWBOX_H = 1500
const MARGIN = 24
/** 掩膜相对 SVG 单位的分辨率（每单位几个像素），越高轮廓越细腻也越慢 */
const MASK_SCALE = 3
/** 推导分区用的整幅栅格分辨率（低于 MASK_SCALE，布尔运算吃内存） */
const GRID_SCALE = 1.5
/** 轮廓简化容差（SVG 单位） */
const SIMPLIFY_TOL = 0.55
/** 小于此面积（SVG 单位²）的环视为噪点丢弃 */
const MIN_RING_AREA = 1.2
/** 腹直肌半宽占该层腹壁宽度的比例（外侧界≈半月线；见 deriveMissing 注释） */
const RECTUS_SPAN = 0.33

/* ------------------------------------------------------------- 载入 */

function loadMeshes() {
  const need = new Set()
  for (const list of [MUSCLE_MESHES, FILLER_MESHES, BASE_MESHES]) {
    for (const arr of Object.values(list)) for (const id of arr) for (const s of ['', 'M']) need.add(id + s)
  }
  const meshes = new Map()
  const absent = []
  for (const id of need) {
    const p = join(MESH_DIR, `${id}.obj`)
    if (!existsSync(p)) {
      absent.push(id)
      continue
    }
    meshes.set(id, parseObj(readFileSync(p, 'utf8')))
  }
  // 中线结构与皮肤在归档里没有 M 镜像件，属预期缺失；其余缺失说明还没拉取
  const unexpected = absent.filter((id) => !id.endsWith('M'))
  if (unexpected.length) {
    throw new Error(`缺少 ${unexpected.length} 个网格，请先运行 node scripts/fetch-anatomy.mjs\n  ${unexpected.slice(0, 10).join(', ')}`)
  }
  if (!meshes.size) throw new Error('resources/anatomy/meshes 为空，请先运行 node scripts/fetch-anatomy.mjs')
  return meshes
}

/** 展开成 [网格 id...]（自动补 M 镜像件，过滤掉不存在的） */
function meshIdsFor(ids, meshes) {
  const out = []
  for (const id of ids) for (const s of ['', 'M']) if (meshes.has(id + s)) out.push(id + s)
  return out
}

/* --------------------------------------------------------- 视图变换 */

/**
 * 建立「世界坐标 → SVG 坐标」与「世界坐标 → 掩膜像素」两套映射。
 * 三视图共用纵向（Z）比例，因此人体等大；横向各自以自身中线居中。
 */
function makeProjection(view, meshes) {
  let vLo = Infinity
  let vHi = -Infinity
  let uLo = Infinity
  let uHi = -Infinity
  const [ui, vi] = view.axes
  for (const mesh of meshes.values()) {
    const [a, b] = extentOf(mesh, vi)
    if (a < vLo) vLo = a
    if (b > vHi) vHi = b
    const [c, d] = extentOf(mesh, ui)
    if (c < uLo) uLo = c
    if (d > uHi) uHi = d
  }
  // 正面/背面以解剖中线（X=0）为轴；侧面以人体前后中点居中
  const uMid = view.flipU || view.axes[0] === 0 ? 0 : (uLo + uHi) / 2
  const scale = (VIEWBOX_H - MARGIN * 2) / (vHi - vLo)

  const toSvg = (u, v) => [VIEWBOX_W / 2 + (u - uMid) * scale, VIEWBOX_H - MARGIN - (v - vLo) * scale]
  const toMask = {
    x: (u) => (VIEWBOX_W / 2 + (u - uMid) * scale) * MASK_SCALE,
    y: (v) => (VIEWBOX_H - MARGIN - (v - vLo) * scale) * MASK_SCALE,
  }
  return {toSvg, toMask, scale, uMid, vLo, vHi, uLo, uHi}
}

function extentOf(mesh, axis) {
  let lo = Infinity
  let hi = -Infinity
  const v = mesh.verts
  for (let i = axis; i < v.length; i += 3) {
    if (v[i] < lo) lo = v[i]
    if (v[i] > hi) hi = v[i]
  }
  return [lo, hi]
}

/* ----------------------------------------------------- 区域 → 轮廓 */

/**
 * 把一个区域的全部网格投影、栅格化、追踪轮廓，返回
 * `{rings, depth, bbox}`；rings 已在 SVG 坐标系里。
 */
function buildRegion(meshIds, meshes, view, proj) {
  const projected = unionProjection(meshIds, meshes, view)
  if (!projected) return null
  const {uv, faces, depth} = projected

  // 掩膜包围盒（世界坐标）
  let ul = Infinity
  let uh = -Infinity
  let vl = Infinity
  let vh = -Infinity
  for (let i = 0; i < uv.length; i += 2) {
    if (uv[i] < ul) ul = uv[i]
    if (uv[i] > uh) uh = uv[i]
    if (uv[i + 1] < vl) vl = uv[i + 1]
    if (uv[i + 1] > vh) vh = uv[i + 1]
  }

  const {mask, w, h, ox, oy} = rasterize(uv, faces, [ul, vl, uh, vh], proj.toMask)
  const loops = traceContours({mask, w, h})

  // 掩膜像素 → SVG 坐标
  const toSvgX = (px) => (px + ox) / MASK_SCALE
  const toSvgY = (py) => (py + oy) / MASK_SCALE

  const rings = []
  let area = 0
  for (const loop of loops) {
    const pts = loop.map(([px, py]) => [toSvgX(px), toSvgY(py)])
    if (Math.abs(polygonArea(pts)) < MIN_RING_AREA) continue
    const simple = simplify([...pts, pts[0]], SIMPLIFY_TOL)
    simple.pop()
    if (simple.length >= 3) {
      rings.push(simple)
      area += Math.abs(polygonArea(simple))
    }
  }
  if (!rings.length) return null

  let depthSum = 0
  for (let i = 0; i < depth.length; i++) depthSum += depth[i]

  return {rings, area, depthMean: depthSum / depth.length, bbox: [ul, vl, uh, vh]}
}

/** 把多个网格的三角面合并成一次投影（面索引整体偏移） */
function unionProjection(meshIds, meshes, view) {
  const list = meshIds.map((id) => meshes.get(id)).filter(Boolean)
  if (!list.length) return null

  let nv = 0
  let nf = 0
  for (const m of list) {
    nv += m.verts.length
    nf += m.faces.length
  }
  const verts = new Float64Array(nv)
  const faces = new Int32Array(nf)
  let vo = 0
  let fo = 0
  let base = 0
  for (const m of list) {
    verts.set(m.verts, vo)
    for (let i = 0; i < m.faces.length; i++) faces[fo + i] = m.faces[i] + base
    base += m.verts.length / 3
    vo += m.verts.length
    fo += m.faces.length
  }
  const {uv, depth} = projectMesh({verts}, view)
  return {uv, faces, depth}
}

/* ------------------------------------------------ 缺失肌群：由邻接结构推导 */

/** 推导用的整幅栅格（各掩膜必须同栅格才能做布尔运算） */
function makeGrid(proj) {
  const W = Math.round(VIEWBOX_W * GRID_SCALE)
  const H = Math.round(VIEWBOX_H * GRID_SCALE)
  const toPx = {
    x: (u) => proj.toSvg(u, 0)[0] * GRID_SCALE,
    y: (v) => proj.toSvg(0, v)[1] * GRID_SCALE,
  }
  return {W, H, toPx}
}

/** 一组网格在整幅栅格上的掩膜 */
function gridMask(ids, meshes, view, grid) {
  const p = unionProjection(meshIdsFor(ids, meshes), meshes, view)
  if (!p) return null
  return rasterizeToGrid(p.uv, p.faces, grid.toPx, grid.W, grid.H)
}

/** 整幅掩膜 → SVG 坐标下的环（孔洞靠 fill-rule="evenodd" 处理） */
function maskToRings(mask, W, H) {
  const loops = traceContours({mask, w: W, h: H})
  const rings = []
  for (const loop of loops) {
    const pts = loop.map(([px, py]) => [px / GRID_SCALE, py / GRID_SCALE])
    if (Math.abs(polygonArea(pts)) < MIN_RING_AREA) continue
    const simple = simplify([...pts, pts[0]], SIMPLIFY_TOL)
    simple.pop()
    if (simple.length >= 3) rings.push(simple)
  }
  return rings
}

/** 把掩膜按 id 并集后取并集掩膜 */
function unionMasks(list, W, H) {
  const out = new Uint8Array(W * H)
  for (const m of list) if (m) for (let i = 0; i < out.length; i++) out[i] |= m[i]
  return out
}

/**
 * 推导 BodyParts3D 未收录的两个肌群。二者在归档的 IS-A / PART-OF 两棵树上
 * 都不存在（已核对 4.0 全量清单），因此按相邻真实结构的边界求交/求差：
 *
 *   abs （腹直肌）   = 体表 ∧ 腹斜肌所跨的层面 ∧ |u| ≤ 腹斜肌内缘 − 腹斜肌 − 胸大肌
 *   lats（背阔肌）   = 体表 ∧ 腰背层面 ∧ |u| ≤ 邻接结构外缘 − 斜方肌 − 竖脊肌
 *                                                   − 腹斜肌 − 臀大肌 − 大圆肌
 * 每层范围逐行取自相邻网格的实际像素，因此形状跟着真实解剖走。
 */
function deriveMissing(masks, grid, proj) {
  const {W, H} = grid
  const {scale, uMid} = proj
  const toU = (px) => (px / GRID_SCALE - VIEWBOX_W / 2) / scale + uMid

  const skin = masks.skin
  const obliques = masks.obliques
  const pec = unionMasks([masks['chest-low'], masks['chest-up']], W, H)
  const traps = unionMasks([masks['traps-up'], masks['traps-mid'], masks['traps-low']], W, H)
  const backDeep = unionMasks([masks['lower-back'], masks.teres, masks['glute-max']], W, H)

  /** 逐行统计某个掩膜里离中线最近 / 最远的 |u| */
  const rowSpan = (mask, mode) => {
    const out = new Float64Array(H).fill(mode === 'min' ? Infinity : -Infinity)
    for (let y = 0; y < H; y++) {
      let best = mode === 'min' ? Infinity : -Infinity
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue
        const au = Math.abs(toU(x + 0.5))
        if (mode === 'min' ? au < best : au > best) best = au
      }
      out[y] = best
    }
    return out
  }

  const derived = {}

  // ---- 腹直肌：位于腹直肌鞘内，外侧界是半月线。
  // BodyParts3D 的 external oblique 把腱膜也建了进去（内缘已到中线 ~5 mm），
  // 所以不能拿它的内缘当腹直肌边界 —— 那个值量到的是腱膜不是肌腹。
  // 改用逐行的比例：腹直肌约占该层腹壁宽度的 1/3，与解剖图谱的观感一致；
  // 上宽下窄也自然跟着腹斜肌的外缘走。胸大肌要扣掉，别让腹直肌爬到胸上。
  if (obliques && skin) {
    const outer = rowSpan(obliques, 'max')
    const abs = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      const span = outer[y]
      if (!Number.isFinite(span) || span <= 0) continue
      const hw = span * RECTUS_SPAN
      for (let x = 0; x < W; x++) {
        if (!skin[y * W + x]) continue
        if (Math.abs(toU(x + 0.5)) <= hw) abs[y * W + x] = 1
      }
    }
    combine(abs, {sub: [pec]})
    derived.abs = abs
  }

  // ---- 背阔肌：腰背层面内，被斜方/竖脊/腹斜/臀大/大圆肌夹出来的那块
  if (skin && traps) {
    const outer = rowSpan(unionMasks([traps, obliques, backDeep], W, H), 'max')
    const top = unionMasks([masks.teres, masks['traps-low']], W, H)
    const bottom = masks['glute-max']
    const rows = new Uint8Array(H)
    for (let y = 0; y < H; y++) {
      // 纵向范围：大圆肌（上界）与臀大肌（下界）之间
      let hasTop = false
      let hasBottom = false
      for (let x = 0; x < W; x++) {
        if (top[y * W + x]) hasTop = true
        if (bottom[y * W + x]) hasBottom = true
      }
      rows[y] = hasTop && !hasBottom ? 1 : 0
    }
    // 从大圆肌所在的行向下延伸到臀大肌上缘
    let firstTop = -1
    let lastTop = -1
    let firstBottom = H
    for (let y = 0; y < H; y++) {
      if (rows[y] && firstTop < 0) firstTop = y
      if (rows[y]) lastTop = y
      if (bottom && firstBottom === H) {
        for (let x = 0; x < W; x++) if (bottom[y * W + x]) { firstBottom = y; break }
      }
    }
    const y0 = firstTop >= 0 ? firstTop : 0
    const y1 = firstBottom < H ? firstBottom : H - 1

    const lats = new Uint8Array(W * H)
    for (let y = y0; y <= y1; y++) {
      const lim = outer[y]
      if (!Number.isFinite(lim) || lim <= 0) continue
      for (let x = 0; x < W; x++) {
        if (!skin[y * W + x]) continue
        if (Math.abs(toU(x + 0.5)) > lim) continue
        lats[y * W + x] = 1
      }
    }
    combine(lats, {sub: [traps, backDeep, obliques, pec]})
    derived.lats = lats
  }

  return derived
}

/* --------------------------------------------------------------- 主流程 */

function buildView(name, view, meshes) {
  const proj = makeProjection(view, meshes)
  const grid = makeGrid(proj)
  const regions = []

  const push = (key, ids, kind, layer) => {
    const r = buildRegion(meshIdsFor(ids, meshes), meshes, view, proj)
    if (r) regions.push({key, kind, layer, ...r})
  }

  for (const [key, ids] of Object.entries(MUSCLE_MESHES)) {
    push(key, ids, 'm', DEEP_KEYS.has(key) ? 2 : 1)
  }
  for (const [key, ids] of Object.entries(FILLER_MESHES)) {
    push(key, ids, 'a', 2)
  }

  const skin = buildRegion(meshIdsFor(BASE_MESHES.skin, meshes), meshes, view, proj)

  // 推导缺失的两个肌群：需要邻接结构的同栅格掩膜
  const need = ['skin', 'obliques', 'chest-low', 'chest-up', 'traps-up', 'traps-mid', 'traps-low', 'lower-back', 'glute-max']
  const masks = {}
  masks.skin = gridMask(BASE_MESHES.skin, meshes, view, grid)
  for (const k of need) {
    const ids = MUSCLE_MESHES[k] || FILLER_MESHES[k]
    if (ids) masks[k] = gridMask(ids, meshes, view, grid)
  }
  masks.teres = gridMask(FILLER_MESHES['teres-major'], meshes, view, grid)

  const derived = deriveMissing(masks, grid, proj)
  for (const [key, mask] of Object.entries(derived)) {
    const rings = maskToRings(mask, grid.W, grid.H)
    if (!rings.length) continue
    // 腹直肌、背阔肌都是体表肌，深度取浅层
    regions.push({key, kind: 'm', layer: 1, rings, depthMean: 0, derived: true})
  }

  // 画家算法：观察深度小的先画（远的在下）。推导分区没有深度，
  // 按解剖位置插到浅层：腹直肌压在最前、背阔肌贴在斜方肌之下。
  const anchors = {
    abs: () => {
      const anchor = regions.find((r) => r.key === 'obliques')
      return anchor ? anchor.depthMean + 0.5 : 0
    },
    lats: () => {
      const anchor = regions.find((r) => r.key === 'traps-mid')
      return anchor ? anchor.depthMean - 0.5 : 0
    },
  }
  for (const r of regions) if (r.derived) r.depthMean = anchors[r.key] ? anchors[r.key]() : 0

  regions.sort((a, b) => a.depthMean - b.depthMean)

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_W} ${VIEWBOX_H}">`)
  parts.push(`<title>肌群激活图 · ${VIEW_LABEL[name]}</title>`)
  parts.push('<g id="base">')
  if (skin) parts.push(`<path d="${ringsToPath(skin.rings)}"/>`)
  parts.push('</g>')

  const maxDepth = regions.length ? regions[regions.length - 1].depthMean : 0
  const minDepth = regions.length ? regions[0].depthMean : 0
  for (const r of regions) {
    // 0 = 最靠近观察者
    const d = maxDepth - minDepth > 1e-6 ? (r.depthMean - minDepth) / (maxDepth - minDepth) : 0
    parts.push(`<g class="${r.kind}" data-m="${r.key}" data-layer="${r.layer}" data-depth="${(d * 9).toFixed(1)}">`)
    parts.push(`<path d="${ringsToPath(r.rings)}"/>`)
    parts.push('</g>')
  }
  parts.push('</svg>')
  return parts.join('')
}

const VIEW_LABEL = {front: '正面', back: '背面', side: '侧面'}

function main() {
  const meshes = loadMeshes()
  console.log(`已载入 ${meshes.size} 个解剖网格`)

  mkdirSync(OUT_DIR, {recursive: true})
  for (const [name, view] of Object.entries(VIEWS)) {
    const svg = buildView(name, view, meshes)
    const out = join(OUT_DIR, `${name}.svg`)
    writeFileSync(out, svg)
    console.log(`  ✓ ${name}.svg  ${(svg.length / 1024).toFixed(1)} KB`)
  }
}

main()
