/**
 * 解剖网格 → 二维轮廓：OBJ 解析、正交投影、栅格化、等值线追踪、路径简化。
 *
 * 坐标约定（BodyParts3D，单位 mm）：
 *   X = 左(+) / 右(−)，Y = 前(−) / 后(+)，Z = 上(+) / 下(−)
 * 身高约 1700 mm，Z 的原点在踝关节附近。
 *
 * 三视图的正交投影与「观察深度」：
 *   正面 front — 视线 +Y，屏幕 x = X，深度取 −Y（越前越近）
 *   背面 back  — 视线 −Y，屏幕 x = −X，深度取 +Y
 *   侧面 side  — 视线 −X（从受试者左侧看），屏幕 x = Y，深度取 +X
 * 三视图都是「等大正投影」，因此同一解剖在三个视图里比例完全一致。
 */

const EPS = 1e-9

/* ------------------------------------------------------------------ OBJ */

/**
 * 解析 BodyParts3D 的 OBJ。文件头带 `# English name` 与 `# Bounds(mm)`，
 * 一并取出用于自检；面可能是三角形或四边形。
 */
export function parseObj(text) {
  const name = text.match(/^# English name\s*:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const verts = []
  const faces = []

  for (const line of text.split('\n')) {
    if (line.charCodeAt(0) !== 118 /* v */ && line.charCodeAt(0) !== 102 /* f */) continue
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/)
      verts.push(+p[1], +p[2], +p[3])
    } else if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1)
      // 行尾的空 token（CRLF + 尾随空格）解析成 NaN，若直接塞进 Int32Array
      // 会静默变成 0 号顶点，凭空生成横跨全身的三角形 —— 必须先剔掉。
      const idx = []
      for (const tok of p) {
        const i = parseInt(tok, 10)
        if (!Number.isFinite(i) || i === 0) continue
        idx.push(i > 0 ? i - 1 : verts.length / 3 + i)
      }
      // 四边形及以上按扇形三角化
      for (let i = 1; i + 1 < idx.length; i++) faces.push(idx[0], idx[i], idx[i + 1])
    }
  }
  return {name, verts: Float64Array.from(verts), faces: Int32Array.from(faces)}
}

/** 网格在某个轴上的范围 */
export function extent(mesh, axis) {
  let lo = Infinity
  let hi = -Infinity
  const v = mesh.verts
  for (let i = axis; i < v.length; i += 3) {
    if (v[i] < lo) lo = v[i]
    if (v[i] > hi) hi = v[i]
  }
  return [lo, hi]
}

/* ------------------------------------------------------------ 三视图 */

/**
 * 视图定义。`u`/`v` 是投影到屏幕的轴（u→屏幕 x，v→屏幕 y），
 * `d` 是朝向观察者的深度轴，`sign` 让「值越大越靠近观察者」。
 */
export const VIEWS = {
  front: {axes: [0, 2], flipU: false, depthAxis: 1, depthSign: -1},
  back: {axes: [0, 2], flipU: true, depthAxis: 1, depthSign: +1},
  side: {axes: [1, 2], flipU: false, depthAxis: 0, depthSign: +1},
}

/** 网格顶点按视图投影到 (u, v)，同时给出每个顶点的观察深度 */
export function projectMesh(mesh, view) {
  const [ai, aj] = view.axes
  const da = view.depthAxis
  const s = view.depthSign
  const v = mesh.verts
  const n = v.length / 3
  const uv = new Float64Array(n * 2)
  const depth = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = v[i * 3 + ai]
    uv[i * 2] = view.flipU ? -x : x
    uv[i * 2 + 1] = v[i * 3 + aj]
    depth[i] = s * v[i * 3 + da]
  }
  return {uv, depth}
}

/* --------------------------------------------------------- 栅格化 */

/**
 * 把投影后的三角形填充进二值掩膜。
 * `toMask` 把世界坐标 (u, v) 映射到掩膜像素；用重心坐标做逐像素测试，
 * 网格密度不高（每块 1–6 k 面）时比扫描线更好写且足够快。
 */
export function rasterize(uv, faces, bbox, toMask) {
  const [u0, v0, u1, v1] = bbox
  // v 向上而像素 y 向下：v1 是上边、v0 是下边
  const px0 = toMask.x(u0)
  const px1 = toMask.x(u1)
  const pyTop = toMask.y(v1)
  const pyBottom = toMask.y(v0)
  const w = Math.max(1, Math.ceil(px1 - px0) + 2)
  const h = Math.max(1, Math.ceil(pyBottom - pyTop) + 2)
  const mask = new Uint8Array(w * h)
  const ox = px0 - 1
  const oy = pyTop - 1

  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 2
    const b = faces[f + 1] * 2
    const c = faces[f + 2] * 2
    const ax = toMask.x(uv[a]) - ox
    const ay = toMask.y(uv[a + 1]) - oy
    const bx = toMask.x(uv[b]) - ox
    const by = toMask.y(uv[b + 1]) - oy
    const cx = toMask.x(uv[c]) - ox
    const cy = toMask.y(uv[c + 1]) - oy

    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (Math.abs(area) < EPS) continue
    const inv = 1 / area

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)))

    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * inv
        if (w0 < 0) continue
        const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) * inv
        if (w1 < 0) continue
        if (w0 + w1 > 1) continue
        mask[y * w + x] = 1
      }
    }
  }
  return {mask, w, h, ox, oy}
}

/**
 * 与 rasterize 相同的重心坐标填充，但写进一张预先定好尺寸的整幅掩膜。
 * 供「由相邻结构推导缺失肌群」的布尔运算使用（需要多块掩膜对齐到同一栅格）。
 */
export function rasterizeToGrid(uv, faces, toPx, W, H) {
  const mask = new Uint8Array(W * H)
  const ok = (v) => v > -1e6 && v < 1e6

  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 2
    const b = faces[f + 1] * 2
    const c = faces[f + 2] * 2
    const ax = toPx.x(uv[a])
    const ay = toPx.y(uv[a + 1])
    const bx = toPx.x(uv[b])
    const by = toPx.y(uv[b + 1])
    const cx = toPx.x(uv[c])
    const cy = toPx.y(uv[c + 1])
    if (!ok(ax) || !ok(ay) || !ok(bx) || !ok(by) || !ok(cx) || !ok(cy)) continue

    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (Math.abs(area) < EPS) continue
    const inv = 1 / area

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))

    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * inv
        if (w0 < 0) continue
        const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) * inv
        if (w1 < 0 || w0 + w1 > 1) continue
        mask[y * W + x] = 1
      }
    }
  }
  return mask
}

/** 就地布尔运算：dst ∪= or，dst ∩= and，dst \= sub（掩膜同尺寸、同栅格） */
export function combine(dst, {and, or, sub}) {
  for (const m of or || []) for (let i = 0; i < dst.length; i++) dst[i] |= m[i]
  for (const m of and || []) for (let i = 0; i < dst.length; i++) dst[i] &= m[i]
  for (const m of sub || []) for (let i = 0; i < dst.length; i++) if (m[i]) dst[i] = 0
  return dst
}

/* ------------------------------------------------------- 等值线追踪 */

/**
 * 二值掩膜的等值线（marching squares，取棱中点）。
 *
 * 逐格看四条棱：两端像素一内一外即「被穿过」，把穿过的棱中点两两相连。
 * 每个棱中点恰好属于两个格子，因此线段能首尾相接串成闭环；环绕方向
 * 由叉积判定，外环与孔洞方向相反，配合 fill-rule="evenodd" 天然成孔。
 */
export function traceContours({mask, w, h}) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x])

  // 端点用棱中点表示；x 方向棱中点坐标 (x+0.5, y)，y 方向 (x, y+0.5)
  // 统一编码成 (2x+1, 2y) / (2x, 2y+1) 的整数键，便于哈希
  const segs = []
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y)
      const tr = at(x + 1, y)
      const br = at(x + 1, y + 1)
      const bl = at(x, y + 1)
      const crossed = []
      if (tl !== tr) crossed.push([2 * x + 1, 2 * y]) // 上棱
      if (tr !== br) crossed.push([2 * x + 2, 2 * y + 1]) // 右棱
      if (br !== bl) crossed.push([2 * x + 1, 2 * y + 2]) // 下棱
      if (bl !== tl) crossed.push([2 * x, 2 * y + 1]) // 左棱
      if (crossed.length === 2) {
        segs.push([crossed[0], crossed[1]])
      } else if (crossed.length === 4) {
        // 鞍点：用中心像素值决定连接方式
        const center = at(x, y) || at(x + 1, y) || at(x + 1, y + 1) || at(x, y + 1)
        if (center) {
          segs.push([crossed[0], crossed[1]], [crossed[2], crossed[3]])
        } else {
          segs.push([crossed[0], crossed[3]], [crossed[1], crossed[2]])
        }
      }
    }
  }

  // 端点 → 线段索引，串成闭环
  const key = ([x, y]) => x * 100003 + y
  const links = new Map()
  for (let i = 0; i < segs.length; i++) {
    for (const p of segs[i]) {
      const k = key(p)
      if (!links.has(k)) links.set(k, [])
      links.get(k).push(i)
    }
  }

  const used = new Uint8Array(segs.length)
  const loops = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const loop = [segs[i][0], segs[i][1]]
    let tail = segs[i][1]
    for (;;) {
      const cand = links.get(key(tail)) || []
      let next = -1
      for (const j of cand) {
        if (!used[j]) {
          next = j
          break
        }
      }
      if (next < 0) break
      used[next] = 1
      const [p, q] = segs[next]
      tail = key(p) === key(tail) ? q : p
      if (key(tail) === key(loop[0])) break
      loop.push(tail)
    }
    if (loop.length >= 4) loops.push(loop)
  }

  // 半整数网格 → 像素坐标
  return loops.map((loop) => loop.map(([x, y]) => [x / 2, y / 2]))
}

/* --------------------------------------------------------- 简化 */

/** 环的面积（用于丢弃噪点小环，并判断方向） */
export function polygonArea(pts) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  }
  return a / 2
}

/** Douglas–Peucker 折线简化（closed 环按首尾同点处理） */
export function simplify(points, tolerance) {
  if (points.length <= 4) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  const tol2 = tolerance * tolerance

  while (stack.length) {
    const [s, e] = stack.pop()
    if (e - s < 2) continue
    const [sx, sy] = points[s]
    const [ex, ey] = points[e]
    const dx = ex - sx
    const dy = ey - sy
    const len2 = dx * dx + dy * dy
    let best = -1
    let bestD = tol2
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i]
      let d
      if (len2 < EPS) {
        d = (px - sx) ** 2 + (py - sy) ** 2
      } else {
        let t = ((px - sx) * dx + (py - sy) * dy) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        d = (px - (sx + t * dx)) ** 2 + (py - (sy + t * dy)) ** 2
      }
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    if (best > 0) {
      keep[best] = 1
      stack.push([s, best], [best, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

/**
 * 把简化后的环转成 SVG 路径片段。所有环拼进同一个 `d`，
 * 由 fill-rule="evenodd" 处理孔洞。
 */
export function ringsToPath(rings, round = 1) {
  const r = (n) => {
    const v = Math.round(n * 10 ** round) / 10 ** round
    return Object.is(v, -0) ? 0 : v
  }
  let d = ''
  for (const ring of rings) {
    if (ring.length < 3) continue
    d += `M${r(ring[0][0])} ${r(ring[0][1])}`
    for (let i = 1; i < ring.length; i++) d += `L${r(ring[i][0])} ${r(ring[i][1])}`
    d += 'Z'
  }
  return d
}
