/**
 * 生成应用图标：src-tauri/icons/icon.ico（256×256 PNG 条目）+ icon.png（512 源图）。
 * 纯 Node 实现（zlib 内置），无第三方依赖。设计 = 深色圆角底 + Rein 三环（摄入红 / 运动绿 / 均衡青）。
 *
 * 用法：npm run icon
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA 像素 → PNG 文件 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------- 绘制 ---------- */

const S = 512 // 画布
const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const scale = size / S
  const cx = S / 2
  const cy = S / 2
  const cornerR = 118 // iOS 圆角比例 ≈ 22.4%
  const bgA = [17, 17, 20]
  const bgB = [32, 30, 40]

  /** 进度弧：(起始角°, 扫过角°, 半径, 半宽, 颜色)，角度从正上方顺时针 */
  const rings = [
    { start: -90, sweep: 312, r: 152, w: 31, color: [250, 17, 79] },
    { start: -90, sweep: 268, r: 112, w: 31, color: [146, 232, 42] },
    { start: -90, sweep: 224, r: 72, w: 31, color: [30, 234, 239] },
  ]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) / scale
      const fy = (y + 0.5) / scale

      // 圆角矩形覆盖测试（带 1.5px 抗锯齿）
      const dxr = Math.abs(fx - cx) - (cx - cornerR)
      const dyr = Math.abs(fy - cy) - (cy - cornerR)
      const distCorner = Math.hypot(Math.max(dxr, 0), Math.max(dyr, 0))
      const insideRect =
        Math.max(dxr, dyr) <= 0
          ? 1
          : 1 - smooth(-1.5, 1.5, distCorner - cornerR + Math.min(Math.max(dxr, dyr), 0) * 0)
      const alpha = insideRect <= 0 ? 0 : Math.min(1, insideRect)
      if (alpha === 0) continue

      // 背景：对角渐变
      const t = (fx + fy) / (S * 2)
      let r = bgA[0] + (bgB[0] - bgA[0]) * t
      let g = bgA[1] + (bgB[1] - bgA[1]) * t
      let b = bgA[2] + (bgB[2] - bgA[2]) * t

      // 圆环
      const dx = fx - cx
      const dy = fy - cy
      const dist = Math.hypot(dx, dy)
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI // -180..180，0 = 右
      for (const ring of rings) {
        const track = 1 - smooth(ring.w / 2 - 1.5, ring.w / 2 + 1.5, Math.abs(dist - ring.r))
        if (track > 0) {
          // 轨道（暗淡整圈）
          r += (ring.color[0] - r) * 0.16 * track
          g += (ring.color[1] - g) * 0.16 * track
          b += (ring.color[2] - b) * 0.16 * track
        }
        // 进度弧
        let rel = ((ang - ring.start) % 360 + 360) % 360
        if (rel <= ring.sweep && Math.abs(dist - ring.r) < ring.w / 2 + 1.5) {
          const band = 1 - smooth(ring.w / 2 - 1.5, ring.w / 2 + 1.5, Math.abs(dist - ring.r))
          // 端点圆帽
          const capR = ring.w / 2
          const endDeg = ring.start + ring.sweep
          const ptAt = (deg) => [
            cx + ring.r * Math.cos((deg * Math.PI) / 180),
            cy + ring.r * Math.sin((deg * Math.PI) / 180),
          ]
          const capStart = Math.hypot(fx - ptAt(ring.start)[0], fy - ptAt(ring.start)[1])
          const capEnd = Math.hypot(fx - ptAt(endDeg)[0], fy - ptAt(endDeg)[1])
          const cap = Math.max(
            1 - smooth(capR - 1.5, capR + 1.5, capStart),
            rel > ring.sweep - 12 ? 1 - smooth(capR - 1.5, capR + 1.5, capEnd) : 0,
          )
          const a = Math.max(band * (rel < 10 ? smooth(0, 10, rel) : 1), cap)
          if (a > 0) {
            r += (ring.color[0] - r) * a
            g += (ring.color[1] - g) * a
            b += (ring.color[2] - b) * a
          }
        }
      }

      const i = (y * size + x) * 4
      px[i] = Math.round(r)
      px[i + 1] = Math.round(g)
      px[i + 2] = Math.round(b)
      px[i + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, px)
}

/* ---------- 输出 ICO（内嵌 PNG 的 256×256 条目） ---------- */

function buildIco(png256) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256 → 0
  entry[1] = 0 // height 256 → 0
  entry[2] = 0 // palette
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png256.length, 8)
  entry.writeUInt32LE(22, 12) // offset
  return Buffer.concat([header, entry, png256])
}

mkdirSync(join(root, 'src-tauri/icons'), { recursive: true })
const png512 = drawIcon(512)
writeFileSync(join(root, 'src-tauri/icons/icon.png'), png512)
writeFileSync(join(root, 'src-tauri/icons/icon.ico'), buildIco(drawIcon(256)))
console.log('icons generated: src-tauri/icons/icon.ico + icon.png')
