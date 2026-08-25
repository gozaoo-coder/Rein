/**
 * 医科解剖素材预处理（wger/OpenStax，CC BY-SA 4.0）：resources/muscles/*.svg → src/assets/muscles/med/*.svg
 *
 * 每个 overlay 与底图同画布堆叠渲染；此脚本做三件事：
 *  1. 补 viewBox、去掉固定 width/height（改为容器控制尺寸）；
 *  2. 剥掉 path 上的内联 style（fill/opacity），改由组件 CSS 变量着色；
 *  3. 底图单一大路径坐标降到 2 位小数（渲染尺寸 ~100px 下无损，体积减半）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'resources/muscles')
const OUT = path.join(ROOT, 'src/assets/muscles/med')

fs.mkdirSync(OUT, { recursive: true })

const round2 = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : n
}

function shrinkPathData(d) {
  return d.replace(/-?\d+\.\d{3,}/g, (m) => round2(m))
}

for (const file of fs.readdirSync(SRC)) {
  if (!file.endsWith('.svg')) continue
  let s = fs.readFileSync(path.join(SRC, file), 'utf-8')

  // 1. viewBox / 尺寸
  const w = /width="([\d.]+)"/.exec(s)?.[1]
  const h = /height="([\d.]+)"/.exec(s)?.[1]
  if (!w || !h) throw new Error(`${file}: missing width/height`)
  s = s
    .replace(/(<svg\b[^>]*?)\swidth="[\d.]+"/, '$1')
    .replace(/(<svg\b[^>]*?)\sheight="[\d.]+"/, '$1')
    .replace(/<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`)

  // 2. 剥内联样式
  s = s.replace(/\sstyle="[^"]*"/g, '')

  // 3. 底图瘦身（仅 front/back 是大文件，正则限定在 d="..." 内）
  if (file === 'front.svg' || file === 'back.svg') {
    s = s.replace(/\sd="([^"]*)"/g, (_, d) => ` d="${shrinkPathData(d)}"`)
  }

  fs.writeFileSync(path.join(OUT, file), s)
  console.log(`${file}: ${(s.length / 1024).toFixed(1)} KB`)
}
console.log('done →', OUT)
