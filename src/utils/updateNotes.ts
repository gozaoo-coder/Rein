/**
 * 更新说明过滤：只留「比本机版本更高」的段落。
 *
 * 清单里的 notes 是**整份 RELEASE_NOTES.md**（scripts/release/publish.mjs 原样读整篇塞进去的），
 * 于是每次更新都把 v0.2.1 一路铺到最新版 —— 用户看到的大半是自己已经装过的内容，
 * 真正要看的「这次改了什么」被埋在最上面那段之外。这里按 `## vX.Y.Z` 切段，
 * 只保留版本高于本机的段（含其正文），顺序不变。
 *
 * 两个刻意的取舍，都是「宁可多显示，不可不显示」：
 * 1. **解析不出任何版本标题 → 原样返回**。说明文本是外部输入（服务端 / 自定义更新源），
 *    哪天换了格式，也不能把更新说明变成一片空白；
 * 2. **本机版本解析不出来 → 同样原样返回**，理由同上。
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
