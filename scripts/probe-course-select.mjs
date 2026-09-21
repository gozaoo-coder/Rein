/**
 * 选课链路探测（**只读**）。
 *
 * 存在的理由：`course-watch.mjs` 拉起 AI 会话时会让它跑这个脚本核对教务真实返回，
 * 但脚本一直不存在 —— 会话只能临场 improvisation。而窗口开放后最要紧的事恰恰是
 * 「把真实响应结构看清楚」，这件事应该有一条固定、可重复、谁都能跑的路。
 *
 * 它打的全是 GET / 查询类接口，**从不提交、不占位、不退课**：
 *   EAMS 会话 → 选课 SSO 令牌 → 服务器时间 → 学生档案 → open-turns
 *   → turn select（核对两条 id 是否相等）→ query-condition → query-lesson
 *   → simplest-lessons → selected-lessons
 *
 * 用法：
 *   node scripts/probe-course-select.mjs          # 人类可读
 *   node scripts/probe-course-select.mjs --json   # 一份完整 JSON（给 AI / 归档）
 *   node scripts/probe-course-select.mjs --raw    # 第一行教学班完整打印（默认截断）
 *
 * 凭据只从本地库读，不打印、不落盘；账号与会话都是只读使用。
 */
import { connect, readAccount, TOKEN_EXPIRED } from './lib/guet-session.mjs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const raw = argv.includes('--raw')

const out = { at: new Date().toISOString(), ok: false, steps: {}, error: null }
const say = (s) => {
  if (!asJson) console.log(s)
}
const cut = (v, n = 1200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1)
  return s && s.length > n ? s.slice(0, n) + `\n…（共 ${s.length} 字节）` : s
}

try {
  const account = readAccount()
  const { session, via } = await connect(account)
  out.steps.account = { user: account.user, base: account.base, via }
  say(`账号 ${account.user} @ ${account.base}（会话来源：${via === 'cookie' ? '复用库里的会话' : '密码登录'}）`)

  const alive = await session.probe()
  out.steps.sessionAlive = alive
  say(`会话探针 /student/home：${alive ? '有效' : '无效（302 回登录页）'}`)
  if (!alive) throw new Error('会话不可用：请在 App 里重新登录教务')

  const tok = await session.acquireToken()
  out.steps.token = { ok: tok.ok, exp: tok.exp ?? null, message: tok.ok ? null : tok.message }
  say(`选课 SSO 令牌：${tok.ok ? `已获取（exp=${tok.exp}）` : tok.message}`)
  if (!tok.ok) throw new Error(tok.message)

  out.steps.serverTime = await session.serverTime()
  say(`教务服务器时间：${out.steps.serverTime}`)

  const students = await session.students()
  const me = students?.[0] ?? null
  out.steps.students = students
  say(`学生档案：${me ? `${me.code}（id=${me.id}）` : '（空）'}`)
  if (!me?.id) throw new Error('教务没返回学生档案，拿不到 studentId')

  const turns = (await session.openTurns(me.id)) ?? []
  out.steps.turns = turns
  say(`\n=== open-turns：${turns.length} 个批次 ===`)
  for (const t of turns) say(` · id=${t.id} 「${t.name ?? t.id}」 allowEnter=${t.allowEnter === true}`)

  const enterable = turns.filter((t) => t.allowEnter === true)
  if (!enterable.length) {
    say('\n当前没有可进入的批次 —— 窗口未开是常态，不是故障。')
    out.ok = true
  } else {
    for (const turn of enterable) {
      const tid = turn.id
      say(`\n=== 批次 ${tid}「${turn.name ?? ''}」 ===`)

      // 进入批次：提交体里的 courseSelectTurnAssoc 用这里返回的批次 id。
      // **实测（2026-09-21）它在顶层 `turn.id`，不在 `options.turn.id`** —— 后者根本不存在，
      // 所以别再照旧假设去找（列表 id 与它这次恰好相等，但那不是保证）。
      const sel = await session.turnSelect(me.id, tid).catch((e) => ({ __err: e.message }))
      const assoc = sel?.turn?.id ?? sel?.options?.turn?.id ?? null
      out.steps[`turnSelect:${tid}`] = sel
      say(` · turn select：${sel?.__err ? '失败 ' + sel.__err : `turn.id=${assoc}`}`)
      say(`   （列表 id ${tid} 与提交用的 id ${assoc ?? '?'} ${String(assoc) === String(tid) ? '相同' : '不同 —— 提交用后者'}）`)

      const cond = await session
        .api(`/query-condition/${tid}`)
        .catch((e) => ({ __err: e.message }))
      out.steps[`condition:${tid}`] = cond
      say(` · query-condition：${cond?.__err ?? `顶层键 ${Object.keys(cond ?? {}).join(',') || '（无）'}`}`)

      const q = await session
        .queryLessons(me.id, tid)
        .catch((e) => ({ __err: e.message }))
      const lessons = q?.lessons ?? (Array.isArray(q) ? q : [])
      out.steps[`lessons:${tid}`] = { total: lessons.length, first: lessons[0] ?? null, err: q?.__err ?? null }
      say(` · query-lesson：${q?.__err ?? `${lessons.length} 个教学班`}`)
      if (lessons[0]) say('   第一行：' + (raw ? cut(lessons[0], 6000) : cut(lessons[0], 1200)))

      const simple = await session.simplestLessons(tid).catch((e) => ({ __err: e.message }))
      const sl = simple?.lessons ?? (Array.isArray(simple) ? simple : [])
      out.steps[`simplest:${tid}`] = { total: sl.length, first: sl[0] ?? null, err: simple?.__err ?? null }
      say(` · simplest-lessons：${simple?.__err ?? `${sl.length} 个教学班`}`)

      const mine = await session.selectedLessons(tid, me.id).catch((e) => ({ __err: e.message }))
      out.steps[`selected:${tid}`] = mine
      const mineList = mine?.lessons ?? (Array.isArray(mine) ? mine : [])
      say(` · selected-lessons：${mine?.__err ?? `${mineList.length} 个已选教学班`}`)
    }
    out.ok = true
  }
} catch (e) {
  out.error = String(e?.message ?? e)
  say(`\n× ${out.error}`)
  if (String(out.error).includes(TOKEN_EXPIRED)) {
    say('  （令牌过期：重跑一次即可，会重新换一张）')
  }
}

if (asJson) console.log(JSON.stringify(out, null, 1))
process.exit(out.ok ? 0 : 1)
