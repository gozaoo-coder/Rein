/**
 * 生成第 2 轮（复审）的 manifest：只包含**被驳回并已改过**的爆点。
 *
 * 复审只重审改动过的镜头（PROJECT-PLAN §6），不全量重跑；而且每人只看 2 张图，
 * 请求体比第 1 轮小一个数量级 —— 第 1 轮的大批失败正是重请求在并发下撞网关。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(process.cwd())
const src = JSON.parse(readFileSync(resolve(REPO, 'promo/out/review-manifest.json'), 'utf8'))

const FIXED = ['09-nutrition', '15-score', '19-ledger', '21-sync', '22-update', '26-workbench']

const items = FIXED.map((id) => {
  const hit = src.items.find((i) => i.id === id)
  if (!hit) throw new Error(`manifest 里找不到 ${id}`)
  return hit
})
for (const it of items) {
  if (!existsSync(it.image)) throw new Error(`图不存在：${it.image}`)
}

const out = resolve(REPO, 'promo/out/review-manifest-round2.json')
writeFileSync(
  out,
  JSON.stringify(
    {
      subject: 'Rein 宣传片 · 第 2 轮复审（驳回后重改的爆点）',
      contactSheet: src.contactSheet,
      items,
      lenses: src.lenses,
      criticsPerLens: src.criticsPerLens,
    },
    null,
    2,
  ),
)
console.log(`✓ 复审 manifest：${items.length} 个爆点 → ${out}`)
