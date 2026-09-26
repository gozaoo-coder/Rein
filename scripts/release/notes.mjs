/**
 * 版本说明的抽取与规范校验 —— 发布侧唯一一份实现。
 *
 * 为什么要有这个文件：`RELEASE_NOTES.md` 是**累积**的（每版一节，新版本在最上面），
 * 而清单里的 `notes` 是**这一次更新**的说明。两者形状不同，从前发布器直接把整份文件
 * 塞进清单，于是：
 *   · 每个客户端每次检查更新都要下整份历史 —— 实测线上清单 79,848 字节，
 *     其中 77,481 字节（97%）是 notes，而用户要看的只是最后一节；
 *   · 客户端不得不自己按 `## vX.Y.Z` 切段过滤（`src/utils/updateNotes.ts`），
 *     把一个本该在发布侧解决的问题搬到每一台手机上做。
 * 所以抽取与裁剪**在这里做**，客户端那份过滤留作兜底（它还得认老清单）。
 *
 * ---------- 更新文案规范（v1，2026-09-26）----------
 * 目标读者是"刚点开更新提示的用户"，不是「读过代码的人」。所以：
 *   1. 只写**用户看得见的变化**：多了什么、修了什么、为什么值得更新；
 *   2. 一组一条 `- `，**最多 5 条**（再多就没人读完了）；
 *   3. 每条**最多 60 字**（不含空白），整段最多 400 字 —— 先说结论，不铺陈推导；
 *   4. 不写实现细节与工程过程（文件名、函数名、`e2e` / `typecheck` / `lint` 这类）；
 *   5. 不嵌套子列表、不用表格、不贴代码块；行内 `` `code` `` 与 `**强调**` 可用；
 *   6. 破坏性 / 需要注意的变化单独一条，以「注意：」开头。
 *
 * 规范由 `checkNotes()` 在**发布时**校验（`publish.mjs` 调用）：不合规直接拒绝发布。
 * 写成文档没人看，写成闸门才拦得住 —— `RELEASE_NOTES.md` 里那些上千字一条的历史条目
 * 正是没有闸门时的产物。
 */

/** 规范上限（改这里就是改规范）。字符数一律按**不含空白**算 —— 中英混排下最稳定的口径 */
export const NOTES_LIMITS = {
  /** 最多几条 */
  bullets: 5,
  /** 单条上限 */
  bulletChars: 60,
  /** 整段上限 */
  totalChars: 400,
}

/** 段标题：`## v0.2.10`（容忍不带 v、带 -beta.1 一类后缀）——与客户端 `updateNotes.ts` 同一套 */
const HEADING = /^##[ \t]+v?(\d+(?:\.\d+)*)[^\n]*$/gm

/** 无歧义的「工程内部词」：出现即说明这条是写给提交日志而不是写给用户的 */
const INTERNAL = /\b(e2e|typecheck|lint|clippy|cargo\s+test)\b/i

/** 非空白字符数（规范里的「字」） */
export function charCount(text) {
  return text.replace(/\s+/g, '').length
}

/**
 * 从累积的 RELEASE_NOTES.md 里抽出某个版本那一节。
 * 返回的 body **含** `## vX.Y.Z` 那一行（客户端按标题切段的逻辑因此照旧成立）。
 */
export function extractVersionNotes(fullText, version) {
  const text = String(fullText ?? '')
  const want = String(version ?? '').trim().replace(/^v/i, '')
  const heads = [...text.matchAll(HEADING)]
  for (let i = 0; i < heads.length; i += 1) {
    const got = heads[i][1].replace(/^v/i, '')
    if (got !== want) continue
    const from = heads[i].index ?? 0
    const to = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length
    return { found: true, body: text.slice(from, to).trim() }
  }
  return { found: false, body: '' }
}

/**
 * 归一成清单里该有的形态：
 *   · 去掉空行（清单是给界面渲染的，段内空行只会平白撑高气泡）；
 *   · 行首的 `·` / `•` / `・` 一并认成列表项 —— 历史条目用的是 `·`，
 *     而 Markdown 渲染器只认 `-`（不这么转，那些段落会整块读成一堆散文）。
 * 幂等：转过的文本再转一次不变。
 */
export function normalizeNotes(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*)[·•・]\s+/, '$1- ').replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim()
}

/**
 * 校验规范。返回 `{ ok, problems }`，problems 里每条都是能直接指给人看的一句话。
 * 只做**客观、无假阳性**的判断：条数 / 字数 / 结构 / 内部词。
 * 「写得有没有信息量」这类判断留给评审，闸门不假装能判。
 */
export function checkNotes(body) {
  const text = String(body ?? '').trim()
  const problems = []
  if (!text) {
    return { ok: false, problems: ['说明是空的'] }
  }

  const lines = text.split('\n')
  const bullets = lines.filter((l) => /^\s*-\s+\S/.test(l))

  if (bullets.length === 0) {
    problems.push('一条 `- ` 条目都没有：只写散文的说明在更新提示里读不成句')
  }
  if (bullets.length > NOTES_LIMITS.bullets) {
    problems.push(`条目 ${bullets.length} 条，超过上限 ${NOTES_LIMITS.bullets} 条`)
  }

  const longBullets = bullets.filter((l) => charCount(l.replace(/^\s*-\s+/, '')) > NOTES_LIMITS.bulletChars)
  if (longBullets.length > 0) {
    const worst = longBullets.reduce((a, b) => (charCount(b) > charCount(a) ? b : a))
    problems.push(
      `${longBullets.length} 条超过单条上限 ${NOTES_LIMITS.bulletChars} 字（最长 ${charCount(worst)} 字）：${worst.trim().slice(0, 40)}…`,
    )
  }

  const total = charCount(text)
  if (total > NOTES_LIMITS.totalChars) {
    problems.push(`全段 ${total} 字，超过上限 ${NOTES_LIMITS.totalChars} 字`)
  }

  if (lines.some((l) => /^\s{2,}-\s+/.test(l))) problems.push('有嵌套子列表：嵌套结构在更新提示里读不出来，请摊平成一条')
  if (lines.some((l) => l.trim().startsWith('|'))) problems.push('有表格：更新提示里不渲染表格，请改成条目')
  if (lines.some((l) => /^\s*```/.test(l))) problems.push('有代码块：更新说明不是技术文档，请改成一句话')

  const internal = lines.filter((l) => INTERNAL.test(l))
  if (internal.length > 0) {
    problems.push(`出现工程内部词（e2e / typecheck / lint / cargo test）：${internal[0].trim().slice(0, 40)}…`)
  }

  return { ok: problems.length === 0, problems }
}

/**
 * 一步到位：抽取 → 归一 → 校验。
 * `publish.mjs` 只调这一个函数，抽取与校验不会各写一份。
 */
export function prepareNotes({ fullText, version, inline }) {
  if (inline !== undefined && inline !== null && String(inline).trim() !== '') {
    const body = normalizeNotes(inline)
    return { body, found: true, source: 'inline', ...checkNotes(body) }
  }
  const { found, body: raw } = extractVersionNotes(fullText ?? '', version)
  if (!found) {
    return {
      body: '',
      found: false,
      source: 'file',
      ok: false,
      problems: [`RELEASE_NOTES.md 里没有 \`## v${version}\` 那一节：先把这一版的说明写上再发`],
    }
  }
  const body = normalizeNotes(raw)
  return { body, found: true, source: 'file', ...checkNotes(body) }
}
