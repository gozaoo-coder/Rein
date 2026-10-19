/**
 * 多代理审核闭环。
 *
 * 每个「审核员」是一次独立的 `cmdc --yolo` 无头运行：给它一个 lens（审查维度）、
 * 一张拼贴总览、以及它被分配到的若干爆点静帧，让它**只看产物**出裁决。
 * 同一 lens 至少 3 名互不通气 —— 单点口味不算数。
 *
 * 为什么让审核员把结果**写文件**而不是从 stdout 抠 JSON：
 * 无头运行的输出里混着工具调用与思考过程，抠 JSON 脆得没有意义；写文件是确定性的。
 *
 * 用法：
 *   node render/review.mjs [--manifest=out/review-manifest.json] [--round=1]
 *                          [--concurrency=6] [--limit=12] [--only=视觉层级] [--dry-run]
 * 产物：promo/review/round-N/{verdicts.json,summary.md,raw/*}
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const REPO = resolve(ROOT, '..')

const CMDC = existsSync('C:/Program Files/nodejs/node_modules/command-code/dist/index.mjs')
  ? 'C:/Program Files/nodejs/node_modules/command-code/dist/index.mjs'
  : null

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const MANIFEST = resolve(REPO, String(flag('manifest', join('promo', 'out', 'review-manifest.json'))))
const ROUND = Number(flag('round', 1))
const CONCURRENCY = Number(flag('concurrency', 6))
const LIMIT = Number(flag('limit', 0))
const ONLY = flag('only', '')
const MISSING = Boolean(flag('missing', false))
const FROM_RAW = Boolean(flag('from-raw', false))
const DRY = Boolean(flag('dry-run', false))
const TIMEOUT_MS = Number(flag('timeout', 240)) * 1000
const OUTDIR = join(ROOT, 'review', `round-${ROUND}`)
const RAW = join(OUTDIR, 'raw')

const slug = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')

function buildReviewers(manifest) {
  const list = []
  let i = 0
  for (const l of manifest.lenses) {
    if (ONLY && l.lens !== ONLY) continue
    for (let c = 1; c <= (manifest.criticsPerLens ?? 3); c += 1) {
      list.push({ id: `${String(i).padStart(2, '0')}-${slug(l.lens)}-${c}`, lens: l.lens, focus: l.focus, critic: c })
      i += 1
    }
  }
  return LIMIT > 0 ? list.slice(0, LIMIT) : list
}

/**
 * 把 30 个爆点**分配给一名审核员**。
 *
 * 关键约束：**每个维度自己的 3 名复评合起来必须覆盖全部 30 个爆点** ——
 * 否则「视觉层级」只看了前 11 个镜头、后半程没人按这个维度审。
 * 所以窗口 = ceil(n / 复评数)，同一维度的三名复评各拿互不重叠的一段。
 */
function assign(items, index, win, critics) {
  const n = items.length
  const start = ((index % critics) * win) % n
  const out = []
  for (let k = 0; k < Math.min(win, n); k += 1) out.push(items[(start + k) % n])
  return out
}

function promptFor(r, beats, manifest) {
  const lines = [
    `你是 Rein 宣传片的独立审核员（第 ${r.critic} 位复评 / 维度「${r.lens}」）。`,
    '你的任务：只依据**画面产物**，对分配给你的每个爆点给出裁决，并把结果写成 JSON 文件。',
    '',
    '## 必读（用 read_file 实际打开图片看，不要凭文件名猜）',
    `1. 整片总览拼贴：${manifest.contactSheet}`,
    `2. 设计简报（品牌、令牌、色彩配额、反例都在里面）：${join(REPO, 'docs', 'PROJECT-2026-10', 'DESIGN-BRIEF.md')}`,
    '（尽量少读别的文件：这条链路的失败几乎都来自请求太重。够用就动手写结论。）',
    '',
    `## 你的审查维度：${r.lens}`,
    r.focus,
    '',
    '## 分配给你的爆点（逐个看图）',
    ...beats.map((b) => `- ${b.id}（${b.label}，${b.at}s）→ ${b.image}`),
    '',
    '## 裁决标准',
    '- blocker：一眼就错（读不清、硬切、静止、跑版、与产品不符、色彩越界）—— 必须打回。',
    '- major：明显拉低质感，但不致命。minor：可改可不改。',
    '- 达不到「可以作为成品发布」就打 reject。宁可严，不要客气。',
    `- 这是「${r.lens}」这一个维度，别去评别的维度；但也别放过你维度内的任何一处。`,
    '',
    '## 输出（必须做）',
    `把**严格 JSON**（不要代码块围栏、不要解释文字）写到这个文件：${join(RAW, `${r.id}.json`)}`,
    '结构：',
    '{',
    '  "reviewer": "<你的 id>",  "lens": "<维度>",',
    '  "verdicts": [',
    '    { "beat": "<爆点 id>", "verdict": "pass|reject", "score": 0-10,',
    '      "issues": [ { "severity": "blocker|major|minor", "what": "现象（具体到像素/位置）", "fix": "怎么改" } ] }',
    '  ],',
    '  "summary": "一句话总评"',
    '}',
    `你的 reviewer id 是：${r.id}`,
  ]
  return lines.join('\n')
}

function runOnce(r, beats, manifest, log) {
  return new Promise((done) => {
    const prompt = promptFor(r, beats, manifest)
    const pfile = join(RAW, `${r.id}.prompt.md`)
    writeFileSync(pfile, prompt, 'utf8')
    const outFile = join(RAW, `${r.id}.json`)
    if (existsSync(outFile)) rmSync(outFile)

    // 传一个**没有引号、没有换行**的短指令：真正的任务写在 prompt 文件里。
    const short = `读取 ${pfile} 并严格照做。必须把裁决 JSON 写到 ${outFile}。不要修改仓库里任何其它文件。`
    const args = [CMDC, '-p', short, '--yolo', '-t', '--no-session', '--skip-onboarding']

    const t0 = Date.now()
    const child = spawn(process.execPath, args, { cwd: REPO, windowsHide: true })
    let tail = ''
    const onData = (d) => {
      tail = (tail + d.toString()).slice(-4000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      child.kill()
      log(`  ⏱ ${r.id} 超时`)
    }, TIMEOUT_MS)

    child.on('close', (code) => {
      clearTimeout(timer)
      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      let parsed = null
      if (existsSync(outFile)) {
        try {
          const raw = readFileSync(outFile, 'utf8').trim().replace(/^```(?:json)?|```$/g, '').trim()
          parsed = JSON.parse(raw)
        } catch (e) {
          log(`  ✗ ${r.id} JSON 解析失败：${e.message}`)
        }
      }
      if (!parsed) writeFileSync(join(RAW, `${r.id}.log`), tail, 'utf8')
      done({ reviewer: r, parsed, outFile, secs, code })
    })
  })
}

/**
 * 重试包装。
 *
 * 无头运行的失败大多不是「审不出东西」，而是**瞬时故障**（API 连不上 / 超时）。
 * 实测 8 并发下有近两成撞上 "Unable to connect to the API" —— 这类失败必须重试，
 * 否则「驳回项」里会混进一堆"没人看"的假阴性。
 */
async function runOne(r, beats, manifest, log) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await runOnce(r, beats, manifest, log)
    if (res.parsed) {
      log(`  · ${r.id}  ${res.secs}s  ${res.parsed.verdicts?.length ?? 0} 条${attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ''}`)
      return res
    }
    if (attempt < 3) {
      log(`  ↻ ${r.id} 无产物（exit=${res.code}），${attempt * 5}s 后重试`)
      await new Promise((s) => setTimeout(s, attempt * 5000))
    } else {
      log(`  ✗ ${r.id} 重试 3 次仍无产物（exit=${res.code}）`)
    }
  }
  return { reviewer: r, parsed: null, outFile: join(RAW, `${r.id}.json`) }
}

async function pool(tasks, n, log) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor
      cursor += 1
      results[idx] = await tasks[idx]()
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  if (!existsSync(MANIFEST)) throw new Error(`找不到 manifest：${MANIFEST}（先跑 node render/shots.mjs）`)
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const items = manifest.items
  const reviewers = buildReviewers(manifest)
  const critics = manifest.criticsPerLens ?? 3
  const win = Math.max(3, Math.ceil(items.length / critics))

  console.log(`审片对象：${manifest.subject} · ${items.length} 个爆点`)
  console.log(`审核员：${reviewers.length} 名（${manifest.lenses.length} 个维度 × ${manifest.criticsPerLens} 复评）· 每人 ${win} 个镜头 · 并发 ${CONCURRENCY}`)

  if (DRY) {
    reviewers.forEach((r, i) => console.log(`  ${r.id}  → ${assign(items, i, win, critics).map((b) => b.id).join(', ')}`))
    return
  }
  if (!CMDC) throw new Error('找不到 cmdc 入口（dist/index.mjs）')

  mkdirSync(RAW, { recursive: true })
  const t0 = Date.now()
  const log = (s) => console.log(s)

  // 断点续审：--missing 只补没有裁决的那几名，已有的直接入账（重跑一整轮既慢又贵）。
  const readVerdict = (r) => {
    const f = join(RAW, `${r.id}.json`)
    if (!existsSync(f)) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8').trim().replace(/^```(?:json)?|```$/g, '').trim())
    } catch {
      return null
    }
  }
  const existing = []
  const pending = []
  reviewers.forEach((r, i) => {
    const parsed = MISSING || FROM_RAW ? readVerdict(r) : null
    if (parsed) existing.push({ reviewer: r, parsed })
    else pending.push({ r, i })
  })
  if (MISSING) console.log(`断点续审：已有 ${existing.length} 份裁决，本轮只补 ${pending.length} 名`)
  if (FROM_RAW) console.log(`只汇总：从 raw/ 读到 ${existing.length} 份裁决，不新起审核员`)

  const tasks = pending.map(({ r, i }) => () => runOne(r, assign(items, i, win, critics), manifest, log))
  const results = FROM_RAW ? existing : [...existing, ...(await pool(tasks, CONCURRENCY, log))]

  // ---- 汇总 ----
  const byItem = new Map()
  for (const it of items) byItem.set(it.id, { id: it.id, label: it.label, at: it.at, reviews: [] })
  const failures = []
  for (const res of results) {
    if (!res.parsed) {
      failures.push(res.reviewer.id)
      continue
    }
    for (const v of res.parsed.verdicts ?? []) {
      const bucket = byItem.get(v.beat)
      if (!bucket) continue
      bucket.reviews.push({ reviewer: res.reviewer.id, lens: res.reviewer.lens, verdict: v.verdict, score: v.score, issues: v.issues ?? [] })
    }
  }

  const report = []
  for (const b of byItem.values()) {
    const rejects = b.reviews.filter((r) => r.verdict === 'reject').length
    const blockers = b.reviews.flatMap((r) => r.issues.filter((i) => i.severity === 'blocker').map((i) => ({ lens: r.lens, ...i })))
    const majors = b.reviews.flatMap((r) => r.issues.filter((i) => i.severity === 'major').map((i) => ({ lens: r.lens, ...i })))
    const scores = b.reviews.map((r) => Number(r.score)).filter((n) => Number.isFinite(n))
    const avg = scores.length ? scores.reduce((a, c) => a + c, 0) / scores.length : 0
    const ratio = b.reviews.length ? rejects / b.reviews.length : 0
    report.push({
      ...b,
      reviews: b.reviews.length,
      rejects,
      rejectRatio: Number(ratio.toFixed(2)),
      avgScore: Number(avg.toFixed(1)),
      blockers,
      majors,
      decision: blockers.length || ratio >= 1 / 3 ? 'REJECT' : 'PASS',
    })
  }
  report.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

  const rejected = report.filter((r) => r.decision === 'REJECT')
  writeFileSync(join(OUTDIR, 'verdicts.json'), JSON.stringify({ round: ROUND, subject: manifest.subject, failures, report }, null, 2))

  const md = []
  md.push(`# 审核报告 · 第 ${ROUND} 轮 · ${manifest.subject}`)
  md.push('')
  md.push(`审核员 ${reviewers.length} 名 · 覆盖 ${items.length} 个爆点 · 驳回 ${rejected.length} 个 · 无法裁决 ${failures.length} 名`)
  md.push('')
  md.push('| 爆点 | 均分 | 打回率 | 裁决 | blocker | major |')
  md.push('| --- | --- | --- | --- | --- | --- |')
  for (const r of report) {
    md.push(`| ${r.at}s ${r.id} | ${r.avgScore} | ${r.rejectRatio} | ${r.decision === 'REJECT' ? '**REJECT**' : 'PASS'} | ${r.blockers.length} | ${r.majors.length} |`)
  }
  md.push('')
  md.push('## 驳回项与改法')
  if (!rejected.length) md.push('- 无')
  for (const r of rejected) {
    md.push(`### ${r.at}s ${r.id}（${r.label}）`)
    const seen = new Set()
    for (const i of [...r.blockers, ...r.majors]) {
      const key = i.what
      if (seen.has(key)) continue
      seen.add(key)
      md.push(`- **${i.severity}** · [${i.lens}] ${i.what}\n  - 改法：${i.fix}`)
    }
    md.push('')
  }
  writeFileSync(join(OUTDIR, 'summary.md'), md.join('\n'), 'utf8')

  console.log('')
  console.log(`--- 第 ${ROUND} 轮汇总（用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟）---`)
  for (const r of report) {
    if (r.decision === 'REJECT') console.log(`  REJECT  ${String(r.at).padStart(4)}s ${r.id}  均分 ${r.avgScore}  打回率 ${r.rejectRatio}  blocker ${r.blockers.length}`)
  }
  console.log(`  通过 ${report.length - rejected.length} / ${report.length}`)
  if (failures.length) console.log(`  ⚠ ${failures.length} 名审核员没有产出裁决：${failures.join(', ')}`)
  console.log(`✓ 报告：${join(OUTDIR, 'summary.md')}`)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
