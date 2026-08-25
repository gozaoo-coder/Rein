/**
 * 医科解剖素材补丁（wger/OpenStax 体系，画布 200×369/369.03）：
 * - front-scm / front-forearm / back-forearm：正背面缺失肌群手绘层（画布系 path，独立 svg）
 * - side-*：侧视图全套（base + 12 个侧向肌群层），面朝左，与正/背同画布同比例
 * 所有层与底图同宽同高、顶端对齐堆叠；侧视图 key 覆盖 12 个 MuscleKey 的侧向外观。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'src/assets/muscles/med')
fs.mkdirSync(OUT, { recursive: true })

const VB = '0 0 200 369'
const VBB = '0 0 200 369.03'
const wrap = (d, vb = VB) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">\n${d}\n</svg>\n`

/* ---------- 正面：SCM / 前臂 ---------- */
fs.writeFileSync(path.join(OUT, 'front-scm.svg'), wrap(
  '<path d="M92 58Q88 70 94 84L101 83Q96 70 100 56Z"/>' +
  '<path d="M108 58Q112 70 106 84L99 83Q104 70 100 56Z"/>'))
fs.writeFileSync(path.join(OUT, 'front-forearm.svg'), wrap(
  '<path d="M46 96Q40 118 46 142L58 140Q50 116 54 94Z"/>' +
  '<path d="M154 96Q160 118 154 142L142 140Q150 116 146 94Z"/>'))

/* ---------- 背面：前臂 / 三角肌后束带 ---------- */
fs.writeFileSync(path.join(OUT, 'back-forearm.svg'), wrap(
  '<path d="M46 96Q40 118 46 142L58 140Q50 116 54 94Z"/>' +
  '<path d="M154 96Q160 118 154 142L142 140Q150 116 146 94Z"/>', VBB))
fs.writeFileSync(path.join(OUT, 'back-deltoid.svg'), wrap(
  '<path d="M40 84Q52 76 64 82L62 90Q52 84 44 92Z"/>' +
  '<path d="M160 84Q148 76 136 82L138 90Q148 84 156 92Z"/>', VBB))

/* ---------- 侧视图（面朝左） ---------- */
const SIDE = {
  base: [
    // 头（侧脸朝左）
    'M92 2Q118 2 121 30Q120 46 108 50Q95 48 91 54Q84 58 77 53Q73 40 82 30Q79 14 92 2Z',
    // 颈
    'M94 50L90 68L106 72L107 54Z',
    // 躯干（胸弧前缘、下背弧后缘）
    'M102 62Q64 68 56 92Q52 112 59 138Q63 160 76 178L118 182Q132 160 134 136Q136 110 133 90Q128 70 104 62Z',
    // 手臂（垂在身侧，前缘贴躯干）
    'M120 70Q132 78 134 98Q136 120 131 144Q129 156 122 162Q118 158 120 144Q114 120 119 96Q115 80 120 70Z',
    // 手
    'M124 162Q130 168 128 176L116 177Q114 168 118 164Z',
    // 腿（大腿前弧、小腿后弧）
    'M74 180Q63 208 61 238Q59 260 66 288Q73 318 86 340L112 338Q124 312 128 284Q130 252 122 222Q116 196 106 180Z',
    // 脚（朝左）
    'M76 338Q58 344 54 352Q57 360 73 358L116 356Q120 348 112 340Z',
  ],
  scm: ['M96 50Q88 56 83 70L92 72Q96 58 103 52Z'],
  traps: ['M84 64Q92 60 104 64L104 73Q92 69 84 73Z'],
  chest: ['M60 84Q57 104 63 124L74 122Q67 104 70 88Z'],
  deltoid: ['M76 72Q92 65 110 70Q113 84 104 95Q88 90 75 84Z'],
  biceps: ['M122 84Q131 95 130 112L121 110Q124 96 117 86Z'],
  triceps: ['M128 84Q135 96 134 112L125 110Q128 96 123 86Z'],
  forearm: ['M124 118Q131 132 128 148L119 146Q124 132 119 120Z'],
  lats: ['M106 74Q126 100 129 136L119 136Q117 104 101 78Z'],
  core: ['M66 132Q73 152 81 170L91 166Q82 148 76 132Z'],
  quads: ['M70 186Q63 214 63 244L74 246Q74 214 82 190Z'],
  hamstrings: ['M102 184Q115 214 119 246L109 248Q105 216 95 188Z'],
  glutes: ['M95 182Q116 178 122 196Q114 214 97 210Z'],
  calves: ['M100 262Q114 288 110 318L100 316Q104 286 92 264Z'],
}
for (const [key, paths] of Object.entries(SIDE)) {
  fs.writeFileSync(path.join(OUT, `side-${key}.svg`), wrap(paths.map((d) => `<path d="${d}"/>`).join('\n')))
}

console.log('med patches + side views done:', fs.readdirSync(OUT).filter((f) => f.startsWith('side') || f.includes('scm') || f.includes('forearm') || f === 'back-deltoid.svg').join(', '))