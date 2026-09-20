import {readFileSync} from 'node:fs'

for (const n of ['front', 'back', 'side']) {
  const s = readFileSync(`src/assets/muscles/rein/${n}.svg`, 'utf8')
  const m = [...s.matchAll(/<g class="(m|a)" data-m="([^"]+)" data-layer="(\d)" data-depth="([^"]+)">/g)]
  const base = /<g id="base"><path d="([^"]*)"/.exec(s)
  const baseLen = base ? base[1].length : 0
  console.log(`\n=== ${n}.svg ===  base path ${baseLen} chars, ${m.length} regions`)
  const by = {}
  for (const x of m) (by[x[1]] ||= []).push(`${x[2]}(L${x[3]})`)
  console.log(`  可高亮 ${(by.m || []).length} 个:`, (by.m || []).join(' '))
  console.log(`  解剖填充 ${(by.a || []).length} 个:`, (by.a || []).join(' '))
}
