/**
 * 旧数据兼容层（读时语义回退）。
 *
 * 规矩（写在代码里，免得下一个改代码的人自己发明一套）：
 *  - 每加一层标一个 `0.0.n` 序号 —— 这条轴独立于 app 版本，也独立于 `db.rs` 的
 *    `MIGRATION_00xx` 轴（那条是 schema 迁移，这条是**语义**回退）；
 *  - 只保留**最近 3 层**（滑窗）：出现 `0.0.4` 时删掉 `0.0.1` 那一行；
 *  - **删行即失效**：某个回退还在不在，由 `COMPAT_LAYERS` 里有没有那一行决定，
 *    调用点一律走 `compatActive(tag)`，不要自己写死 —— 否则「删行即失效」会静默破功；
 *  - **回填铁律**：绝不用另一个字段**伪造**老数据。回退只能「换个说法如实显示」，
 *    不能「编一个值」—— 方向不同的量互相替代会污染口径，而且事后无法回滚。
 */

export interface CompatLayer {
  /** 兼容层序号：0.0.1 / 0.0.2 …（与 app 版本无关） */
  tag: string
  /** 为什么需要这一层 */
  why: string
  /** 什么时候可以丢 */
  dropWhen: string
}

/** 滑窗深度：只留最近 3 层 */
export const COMPAT_WINDOW = 3

export const COMPAT_LAYERS: readonly CompatLayer[] = [
  {
    tag: '0.0.1',
    why:
      '0.6.1 起训练课在总结页采集「训练后体感」（三档、相对预期）。此前的会话没有这个字段 —— ' +
      '练够分的「体感」维度对这些老记录回退用训练前自评（readiness），并如实标明来源是训练前状态。' +
      '不回填：readiness 问的是「今天开始前状态如何」，与「这次练得怎么样」方向不同，' +
      '替它编一个 postFeeling 就是往口径里掺假。',
    dropWhen: '出现 0.0.4 时删掉本行（此后 0.6.1 之前的记录不再享受回退，体感维度如实显示「未记录」）',
  },
]

/** 某层是否仍然生效 —— 删掉 `COMPAT_LAYERS` 里那一行就等于关掉它 */
export function compatActive(tag: string): boolean {
  return COMPAT_LAYERS.some((l) => l.tag === tag)
}

/** 注册表自检：层数 ≤ 滑窗、tag 连续（0.0.1…0.0.n）。返回问题清单，空数组 = 合规 */
export function compatLayersValid(): string[] {
  const problems: string[] = []
  if (COMPAT_LAYERS.length > COMPAT_WINDOW) {
    problems.push(`兼容层 ${COMPAT_LAYERS.length} 层，超过滑窗 ${COMPAT_WINDOW}：该丢最老的一层了`)
  }
  COMPAT_LAYERS.forEach((l, i) => {
    const want = `0.0.${i + 1}`
    if (l.tag !== want) problems.push(`兼容层 tag 不连续：第 ${i + 1} 层是 ${l.tag}，应为 ${want}`)
  })
  return problems
}
