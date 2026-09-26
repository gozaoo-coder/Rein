/**
 * 更新说明过滤：只留「比本机版本更高」的段落。
 *
 * **这一层现在是兜底，不再是主力**。说明的抽取已在发布侧做掉
 * （`scripts/release/notes.mjs` 只把**这一版**那一节写进清单）：线上清单曾实测 79,848 字节，
 * 其中 77,481 字节是累积的整份 RELEASE_NOTES.md —— 每个客户端每次检查更新都要下这一整份历史，
 * 而用户要看的只有最后一节。修在发布侧之后，新清单的 notes 天然只有一节。
 *
 * 之所以还留着它：清单是**外部输入**（服务端 / 自定义更新源 / 老版本清单），
 * 谁也无法保证手上这一份只带一节 —— 拿到的仍然是整份累积文本时，
 * 这一层保证用户不会又被铺一脸自己已经装过的版本。按 `## vX.Y.Z` 切段，
 * 只保留版本高于本机的段（含其正文），顺序不变。
 *
 * 两个刻意的取舍，都是「宁可多显示，不可不显示」：
 * 1. **解析不出任何版本标题 → 原样返回**。说明文本是外部输入，哪天换了格式，
 *    也不能把更新说明变成一片空白；
 * 2. **本机版本解析不出来 → 同样原样返回**，理由同上。
 *
 * 另注：返回的文本是 **Markdown**（`- ` 条目 / `**强调**` / 行内 `` `code` ``），
 * 由 `components/common/MdText.vue` 渲染 —— 调用方不要再按纯文本处理
 * （从前用 `{{ }}` 插值 + `white-space: pre-wrap`，用户看到的是原样的星号与井号）。
 */

/** 段标题：`## v0.2.10`（容忍不带 v、带 -beta.1 一类后缀） */
const HEADING = /^##[ \t]+v?(\d+(?:\.\d+)*)[^\n]*$/gm

/** 版本串 → 数字段。取不到数字返回空数组（= 不可比较） */
function parts(version: string): number[] {
  const m = version.trim().match(/^v?(\d+(?:\.\d+)*)/)
  return m ? m[1]!.split('.').map(Number) : []
}

/** a 是否高于 b；缺位按 0 补（1.2 与 1.2.0 同版） */
function isNewer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * 只保留高于 currentVersion 的段落，拼回一整段纯文本（页面上按 pre-wrap 渲染）。
 * 无标题、本机版本不可解析、或没有任何更高版本时 → 返回原文 / 空串。
 */
export function notesAboveCurrent(notes: string | null | undefined, currentVersion: string): string {
  const text = (notes ?? '').trim()
  if (!text) return ''
  const here = parts(currentVersion)
  if (!here.length) return text

  const heads = [...text.matchAll(HEADING)]
  if (!heads.length) return text

  const keep: string[] = []
  heads.forEach((h, i) => {
    if (!isNewer(parts(h[1]!), here)) return
    const from = h.index ?? 0
    const to = i + 1 < heads.length ? (heads[i + 1]!.index ?? text.length) : text.length
    keep.push(text.slice(from, to).trimEnd())
  })
  // 一段都没有 = 清单里的版本并不比本机高（说明是旧的、或源写错了）。
  // 返回空串让调用方把说明区整块收掉，不编造文案。
  return keep.join('\n\n')
}
