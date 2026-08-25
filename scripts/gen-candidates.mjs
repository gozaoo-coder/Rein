// 生成候选预览素材：public/muscle-candidates/assets/*（调用一次即可）
// A 套用现成 male 资产；B = react-body-highlighter v2 多边形；C = wger 原图；D = rnbpa 317 块
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'public/muscle-candidates/assets')
fs.mkdirSync(OUT, { recursive: true })

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
const write = (f, s) => fs.writeFileSync(path.join(OUT, f), s)

/* ---------- A：melihcolpan（现有 male 资产直接复制） ---------- */
for (const f of fs.readdirSync(path.join(ROOT, 'src/assets/muscles/male'))) {
  fs.copyFileSync(path.join(ROOT, 'src/assets/muscles/male', f), path.join(OUT, f))
}

/* ---------- B：react-body-highlighter v2 多边形 ---------- */
// 从 GitHub raw 拉取 assets/index.ts
const rbhSrc = await fetch('https://raw.githubusercontent.com/giavinh79/react-body-highlighter/master/src/assets/index.ts').then((r) => r.text())
const MUSCLE_MAP = {
  CHEST: 'chest', TRICEPS: 'triceps', NON_EXISTENT: null,
  BICEPS: 'biceps', FOREARM: 'forearm', DELTOID: 'deltoid',
  FRONT_DELTOID: 'deltoid', FRONTDELTOID: 'deltoid',
  TRAPEZIUM: 'traps', TRAPEZIUS: 'traps',
  LAT: 'lats', LATISSIMUS_DORSI: 'lats',
  GLUTES: 'glutes', GLUTEUS_MAXIMUS: 'glutes',
  QUADRICEPS: 'quads', QUAD: 'quads', BICEPS_FEMORIS: 'hamstrings',
  HAMSTRING: 'hamstrings', CALF: 'calves', GASTROCNEMIUS: 'calves',
  ABDOMINAL: 'core', ABDOMINALS: 'core', OBLIQUES: 'core', OBLIQUE: 'core',
  NECK: 'traps', TRAPS: 'traps', LOWERBACK: 'core', UPPERBACK: 'lats',
}
const C = { chest: '#92e82a', triceps: 'rgba(146,232,42,.55)', deltoid: 'rgba(146,232,42,.55)', core: 'rgba(146,232,42,.2)', biceps: 'rgba(146,232,42,.2)' }
const GRUPOS_ACTIVE = ['chest', 'triceps', 'deltoid', 'core']

function polygonsToSvg(idx) {
  const srcPos = rbhSrc.indexOf(`export const ${idx}: ISVGModelData[] = [`)
  if (srcPos < 0) return ''
  const start = rbhSrc.indexOf('= [', srcPos) + 2 // 跳到赋值数组本身
  let depth = 0
  let end = start
  for (; end < rbhSrc.length; end++) {
    const ch = rbhSrc[end]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) break
    }
  }
  const body = rbhSrc.slice(start, end + 1)
  const items = [...body.matchAll(/muscle: [A-Za-z0-9_.]*\.?\s*([A-Z]*[A-Z_]+),\s*svgPoints: \[([\s\S]*?)\]/g)]
  let out = ''
  for (const [, mm, pts] of items) {
    const key = MUSCLE_MAP[mm] ?? null
    const fill = key && GRUPOS_ACTIVE.includes(key) ? C[key] : '#d8d5ce'
    const polys = [...pts.matchAll(/'([^']+)'/g)].map(([, p]) => p.trim()).map((p) => `<polygon points="${p}" fill="${fill}"/>`).join('')
    out += polys
  }
  return out
}
write('b-front.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">${polygonsToSvg('anteriorData')}</svg>`)
write('b-back.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">${polygonsToSvg('posteriorData')}</svg>`)

/* ---------- C：wger 原图 ---------- */
for (const f of ['front.svg', 'back.svg']) fs.copyFileSync(path.join(ROOT, 'resources/muscles', f), path.join(OUT, `c-${f}`))

/* ---------- D：rnbpa 317 块 pathData ---------- */
const rnbpa = read('resources/muscle-candidates/rnbpa_regions.ts')
const D_MAP = { chest: 'chest', triceps: 'triceps', deltoids: 'deltoid', obliques: 'core', abs: 'core', lowerBack: 'core', lower_back: 'core', upperBack: 'lats', upper_back: 'lats', gluteal: 'glutes', hamstring: 'hamstrings', quadriceps: 'quads', calves: 'calves', tibialis: 'calves', forearm: 'forearm', biceps: 'biceps', trapezius: 'traps', neck: 'traps', adductors: 'quads' }
const D_C = { chest: '#92e82a', triceps: 'rgba(146,232,42,.55)', deltoid: 'rgba(146,232,42,.55)', core: 'rgba(146,232,42,.2)' }
const D_ACTIVE = ['chest', 'triceps', 'deltoid', 'core']
function rnbpaToSvg(view, tx, ty) {
  let out = ''
  const parts = rnbpa.split('\n')
  for (const line of parts) {
    const mm = line.match(/slug: "([^"]+)", parentSlug: "([^"]+)", side: "[^"]+", axis: ([^,]+), bbox: \{[^}]*\}, pathData: "([^"]+)" \}/)
    if (!mm) continue
    const [_, slug, group, axis, d] = mm
    if (!slug.includes(`-male-${view}`)) continue
    const key = D_MAP[group] ?? null
    const fill = key && D_ACTIVE.includes(key) ? D_C[key] : '#d8d5ce'
    out += `<path d="${d.replace(/"/g, '&quot;')}" fill="${fill}"/>`
  }
  return out
}
const txOf = (f) => path.join(ROOT, 'src/assets/muscles/male', f)
const m = (f) => fs.readFileSync(txOf(f), 'utf-8').match(/translate\(([-0-9. ]+)\)/)[1].split(' ')
const [ftx, fty] = m('front-base.svg')
const [btx, bty] = m('back-base.svg')
write('d-front.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 670.2 1294.5"><g transform="translate(${ftx} ${fty})">${rnbpaToSvg('front')}</g></svg>`)
write('d-back.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 670.2 1294.5"><g transform="translate(${btx} ${bty})">${rnbpaToSvg('back')}</g></svg>`)

console.log('candidates assets done:', fs.readdirSync(OUT).join(', '))