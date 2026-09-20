/**
 * 校园教务 · **照常**的那一半：培养方案（我该修什么）与预约（提前说好，到点自己抢）。
 *
 * 与 `campus.ts` 的分工是刻意划开的：那边是「不照常」时的最后补救（抢不到、卡住、
 * 教务改了接口），工具描述里反复叮嘱模型「平时不要替我抢」；这一边是平时的正路 ——
 * 用户说「帮我看看还差多少学分 / 这学期该选什么 / 提前把课排好」时该走的路。
 *
 * 两件事各有各的坑：
 *
 * 1. **培养方案那份响应实测 900KB+**（`program-info-json`，见 `campus_program` 命令）。
 *    直接把原样 JSON 丢给模型既撑爆上下文又没信息量，所以这里把它压成四种投影：
 *    档案+学分（overview）、模块学分树（modules）、课程清单（courses）、
 *    以及**本批次教学班与方案课程的逐门对照**（crosscheck）——最后这个才是
 *    「新生只要和培养方案核对」这句话真正需要的形状。
 *
 * 2. **教务按「教学条件组」放课**：不在你培养方案里的课，选课接口会直接拒绝
 *    （`grab.rs` 把带「培养方案」三个字的驳回判成终态，就是踩过的坑）。
 *    所以预约之前要把「这门课在不在我的方案里」逐条标出来 —— 让模型看见，
 *    而不是让它排完一轮、被教务拒了再回头查。
 *
 * 预约本身不新造机制：它落的还是 `grab_intent`（计划），引擎照旧在能看见名单时
 * 自己解析成志愿任务、守着窗口开火。这一层的价值在于**先出预约单再落库**：
 * 模糊查询命中哪些班、还剩多少位置、什么时候开抢，都先摆给人看过。
 */

import { Type } from '@earendil-works/pi-ai'

import { campusService } from '@/services/campusService'
import { idOf, turnWindow } from '@/stores/courseSelect'
import type {
  CourseSelectLesson,
  CourseSelectTurn,
  GrabMatch,
  ProgramCreditNode,
  ProgramInfo,
} from '@/types'
import { note } from './campus'
import { defineTool, type AppTool } from './types'

/* ─────────────────────────── 培养方案：投影与匹配 ─────────────────────────── */

/** 课程名/模块名的归一化：小写化 + 抹掉空白与常见分隔符。
 *  与 Rust `matcher::normalize` 同一套规则 —— 方案里写「大学英语(一)」、教学班里写
 *  「大学英语 （一）」，对人是同一门课，对字符比较却是两门。 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s()（）[\]【】·\-_—/\\、,，.。:：]/g, '')
}

interface ProgramCourseRow {
  id: number
  code?: string
  name: string
  /** 归一化后的课程名 / 课程代码，匹配用，不返回给模型 */
  nName: string
  nCode: string
}

interface ProgramModuleRow {
  name: string
  depth: number
  /** 本节点自己汇总的学分（一级模块常为空，学分挂在子节点上） */
  sumCredit: number | null
  stats: { property: string; credit: number; period: number }[]
}

interface ProgramDoc {
  info: ProgramInfo
  /** 要求总学分（`creditDistrTable.sumCredit`） */
  required: number | null
  modules: ProgramModuleRow[]
  courses: ProgramCourseRow[]
}

/** 学分分布树 → 一维行（用 depth 表达层级，与培养方案页同一个口径：逐级列出，不跨层求和）。 */
function flattenModules(root: ProgramCreditNode | null | undefined): ProgramModuleRow[] {
  const out: ProgramModuleRow[] = []
  const walk = (n: ProgramCreditNode, depth: number): void => {
    out.push({
      name: n.type?.nameZh ?? '未命名模块',
      depth,
      sumCredit: n.sumCredit ?? null,
      stats: (n.courseStatistics ?? []).map((s) => ({
        property: s.courseProperty?.nameZh ?? '—',
        credit: s.sumCredit,
        period: s.sumPeriod,
      })),
    })
    for (const c of n.children ?? []) walk(c, depth + 1)
  }
  for (const c of root?.children ?? []) walk(c, 0)
  return out
}

/** 拉一次培养方案并压成投影。教务没给方案（账号没有/还没同步）时返回 null，由调用方决定怎么说。 */
async function loadProgram(refresh = false): Promise<ProgramDoc | null> {
  const payload = await campusService.program(refresh)
  const info = payload?.programInfos?.[0]
  if (!info) return null
  // 同一门课在清单里出现多次是见过的（教务按开课单位展开），对模型没有意义还会把
  // 「搜到几门」这类判断带偏 —— 按课程代码（退化到课程名）去重，保留第一条。
  const courses: ProgramCourseRow[] = []
  const seen = new Set<string>()
  for (const c of info.courseList ?? []) {
    const name = (c.nameZh ?? c.nameEn ?? '').trim()
    const code = c.code?.trim() || undefined
    const key = normalizeText(code ?? '') || normalizeText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    courses.push({ id: c.id, code, name, nName: normalizeText(name), nCode: normalizeText(code ?? '') })
  }
  return {
    info,
    required: info.creditDistrTable?.sumCredit ?? null,
    modules: flattenModules(info.creditDistrTable),
    courses,
  }
}

/** 一次「这门课在不在方案里」的判定。`takenBy` 说明凭什么认的，模型据此决定话说到多满。 */
type CourseHit = { course: ProgramCourseRow; takenBy: 'code' | 'name' | 'nameLike' }

/** 在方案课程清单里找一门课：**先代码、再全名、最后才是一方包含另一方**。
 *
 *  顺序不能反：代码是教务自己的身份，全名是人的用法，包含式匹配（「大学物理（含实验）」
 *  落在方案里的「大学物理」上）只是兜底 —— 它最容易误伤，所以放在最后，
 *  并且把 `takenBy` 带出去，让模型知道这次判定有多硬。 */
function hitCourse(
  courses: ProgramCourseRow[],
  code?: string | null,
  name?: string | null,
): CourseHit | null {
  const nc = normalizeText(code ?? '')
  const nn = normalizeText(name ?? '')
  if (nc) {
    const byCode = courses.find((c) => c.nCode && c.nCode === nc)
    if (byCode) return { course: byCode, takenBy: 'code' }
  }
  if (nn) {
    const byName = courses.find((c) => c.nName && c.nName === nn)
    if (byName) return { course: byName, takenBy: 'name' }
    const byLike = courses.find(
      (c) => c.nName.length >= 2 && nn.length >= 2 && (nn.includes(c.nName) || c.nName.includes(nn)),
    )
    if (byLike) return { course: byLike, takenBy: 'nameLike' }
  }
  return null
}

/** 本批次教学班按课程聚合成的一行 —— 「这门课在本批次里是什么状态」。 */
interface LessonGroup {
  code?: string
  name: string
  /** 本批次开了几个教学班 */
  sections: number
  /** 其中还有余额的（教务没给人数时按「未知」计入） */
  openSections: number
  /** 已经在你名下的教学班数 */
  pickedSections: number
}

function groupLessons(lessons: CourseSelectLesson[]): LessonGroup[] {
  const map = new Map<string, LessonGroup>()
  for (const l of lessons) {
    const code = l.course?.code?.trim() || undefined
    const name = (l.course?.nameZh ?? l.course?.nameEn ?? '').trim()
    const key = code ?? normalizeText(name)
    if (!key) continue
    const g = map.get(key) ?? { code, name, sections: 0, openSections: 0, pickedSections: 0 }
    g.sections += 1
    const left = l.limitCount != null && l.stdCount != null ? l.limitCount - l.stdCount : null
    if (left == null || left > 0) g.openSections += 1
    if (l.selectedLesson) g.pickedSections += 1
    map.set(key, g)
  }
  return [...map.values()]
}

/** 当前该看哪个批次：给了就看给的，没给就优先「允许进入」的那个，再退第一个。
 *
 *  与 `campus.ts::pickTurn` 同一套优先级，**区别是这里不抛错**：批次还没公布是常态
 *  （大一没到窗口时就是这样），核对与预约都不该因此整个失败 —— 该说的是「窗口还没开」，
 *  而不是一句错误。 */
async function peekTurn(wanted?: string | null): Promise<CourseSelectTurn | null> {
  const status = await campusService.courseSelectStatus()
  const turns = status.turns ?? []
  if (wanted) return turns.find((t) => idOf(t.id) === wanted) ?? null
  return turns.find((t) => t.allowEnter) ?? turns[0] ?? null
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v ?? def))
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

/** 一次预约单里的一行：这句查询会抢到哪几个班（前几个） */
function matchDigest(m: GrabMatch, doc: ProgramDoc | null) {
  const hit = doc ? hitCourse(doc.courses, m.courseCode, m.courseName) : null
  return {
    course: m.courseName ?? undefined,
    code: m.courseCode ?? undefined,
    teacher: m.teacher ?? undefined,
    /** 余量 = 上限 − 已选；两者都缺时为 undefined（教务这次没给人数） */
    seatsLeft: m.stdCount != null && m.limitCount != null ? m.limitCount - m.stdCount : undefined,
    limit: m.limitCount ?? undefined,
    /** 已经在你名下了（解析时会跳过它，不必再抢） */
    picked: m.picked || undefined,
    /** 凭什么匹配到的：course / code / teacher / place / teacherExact 见 Rust `matcher` */
    why: m.fields?.length ? m.fields : undefined,
    /**
     * 在不在你的培养方案里。`false` = 教务会以「不在培养方案」驳回（教学条件组限定），
     * `takenBy` = 判定依据（code 最硬，nameLike 只是包含式兜底）。
     */
    inProgram: doc ? (hit ? { matched: hit.course.name, by: hit.takenBy } : false) : undefined,
  }
}

export const campusProgramTools: AppTool[] = [
  /* ─────────────── 1. 培养方案 ─────────────── */
  defineTool({
    name: 'campus_program',
    group: 'campus',
    label: '培养方案',
    description:
      '读**培养方案**（我该修什么）：方案档案、学分要求与已修、学分分布树、上百门课程清单，' +
      '还能拿本批次的教学班与方案课程**逐门对照**。' +
      '`overview`（默认）= 档案 + 学分缺口 + 顶层模块；`modules` = 模块学分树（含课程性质与学时）；' +
      '`courses` = 课程清单（给 query 按课程名/代码搜，搜不到就是**不在你方案里**，教务多半会拒选）；' +
      '`crosscheck` = 本批次开了哪些方案内的课、哪些课不在方案里（别碰）、哪些方案课这学期没开，' +
      '每门带「开了几个班 / 还有余额的班数 / 你已经选上几个」。' +
      '用户问「我还差多少学分 / 这学期该选什么 / 这门课算不算我的方案课 / 和培养方案核对一下」时用它。',
    parameters: Type.Object({
      view: Type.Optional(
        Type.Union(
          [
            Type.Literal('overview'),
            Type.Literal('modules'),
            Type.Literal('courses'),
            Type.Literal('crosscheck'),
          ],
          { description: '要看哪一面，默认 overview' },
        ),
      ),
      query: Type.Optional(Type.String({ description: 'view=courses 用：课程名或课程代码的关键词' })),
      turnId: Type.Optional(
        Type.String({ description: 'view=crosscheck 用：批次 id，不传 = 教务当前开放的那个' }),
      ),
      limit: Type.Optional(Type.Number({ description: '最多返回多少条（courses 默认 200，crosscheck 默认 60）' })),
      refresh: Type.Optional(Type.Boolean({ description: '强制重拉培养方案（教务改过方案时才用）' })),
    }),
    async execute(args) {
      const view = args.view ?? 'overview'
      const doc = await loadProgram(args.refresh ?? false)
      if (!doc) {
        throw new Error(
          '教务没有返回培养方案（可能是这个账号没有方案，或还没同步过课表）。' +
            '先在「课表配置」里登录并同步一次课表，再回来读培养方案。',
        )
      }

      // 已修学分取自习成绩单（账号上的 totalCredits），与培养方案页同一个口径
      const account = await campusService.accountGet().catch(() => null)
      const earned = account?.totalCredits ?? null
      const credits = {
        required: doc.required,
        earned,
        missing:
          doc.required != null && earned != null ? Math.max(0, doc.required - earned) : undefined,
      }

      if (view === 'modules') {
        const limit = clampInt(args.limit, 120, 1, 400)
        return {
          view,
          profile: { name: doc.info.nameZh, grade: doc.info.grade ?? undefined },
          credits,
          total: doc.modules.length,
          shown: Math.min(limit, doc.modules.length),
          rows: doc.modules.slice(0, limit).map((m) => ({
            module: m.name,
            /** 缩进层级：0 = 一级模块，1 = 二级，以此类推 */
            depth: m.depth,
            sumCredit: m.sumCredit ?? undefined,
            credits: m.stats.length
              ? m.stats.map((s) => `${s.property} ${s.credit} 学分 / ${s.period} 学时`)
              : undefined,
          })),
          tip: '学分逐级列在它自己那一层，不做跨层求和（父节点的数字不含子节点）—— 别把每一层加起来当成总学分。',
        }
      }

      if (view === 'courses') {
        const kw = args.query?.trim() ?? ''
        const nk = normalizeText(kw)
        const matched = nk
          ? doc.courses.filter((c) => c.nName.includes(nk) || (!!c.nCode && c.nCode.includes(nk)))
          : doc.courses
        const limit = clampInt(args.limit, 200, 1, 400)
        return {
          view,
          profile: { name: doc.info.nameZh, major: doc.info.major?.nameZh ?? undefined },
          credits,
          total: doc.courses.length,
          matched: matched.length,
          shown: Math.min(limit, matched.length),
          courses: matched.slice(0, limit).map((c) => ({ code: c.code, name: c.name, id: c.id })),
          tip:
            nk && matched.length === 0
              ? `方案课程清单里没有匹配「${kw}」的课 —— 不在清单里的课通常也不在你的选课范围（教务按教学条件组放课，会直接拒选）。`
              : undefined,
        }
      }

      if (view === 'crosscheck') {
        let turn: CourseSelectTurn | null = null
        let lessons: CourseSelectLesson[] = []
        let blocked: string | undefined
        try {
          turn = await peekTurn(args.turnId)
          if (!turn) throw new Error('教务现在没有开放任何选课批次（窗口还没开是常态）')
          lessons = await campusService.courseSelectLessons(idOf(turn.id), {
            hasCount: true,
            sortField: 'lessonAssoc',
            sortType: 'ASC',
          })
        } catch (e) {
          blocked = e instanceof Error ? e.message : String(e)
        }

        const groups = groupLessons(lessons)
        const inside: unknown[] = []
        const outside: unknown[] = []
        for (const g of groups) {
          const hit = hitCourse(doc.courses, g.code, g.name)
          const row = {
            course: g.name || undefined,
            code: g.code,
            sections: g.sections,
            openSections: g.openSections,
            pickedSections: g.pickedSections,
            matched: hit?.course.name,
          }
          ;(hit ? inside : outside).push(row)
        }
        // 方案里有、本批次却查不到开课的教学班：绝大多数是「别的学期才开」，不是异常
        const notOffered = doc.courses.filter((c) => !groups.some((g) => hitCourse([c], g.code, g.name)))
        const limit = clampInt(args.limit, 60, 1, 300)

        return {
          view,
          profile: { name: doc.info.nameZh, major: doc.info.major?.nameZh ?? undefined },
          credits,
          window: turn
            ? {
                turn: idOf(turn.id),
                name: turn.name ?? undefined,
                allowEnter: turn.allowEnter ?? false,
                ...turnWindow(turn),
                blocked: turn.allowEnter ? undefined : (turn.disallowReasons ?? []).join(' / ') || undefined,
              }
            : undefined,
          /** 拿不到名单时的原文（窗口没开 / 令牌过期 / 教务改版），有它就别猜 */
          blocked,
          counts: {
            lessons: lessons.length,
            coursesInTurn: groups.length,
            inProgram: inside.length,
            outsideProgram: outside.length,
            notOffered: notOffered.length,
          },
          inProgram: inside.slice(0, limit),
          outsideProgram: outside.slice(0, limit),
          notOfferedSample: notOffered.slice(0, 20).map((c) => c.name),
          tip: 'outsideProgram 是本批次有开、但**不在你培养方案**里的课（多半是别的专业的班）——教学条件组会拒，别排它们。notOffered 是方案里有、这学期没开的课，属正常。',
        }
      }

      const topModules = doc.modules.filter((m) => m.depth === 0).map((m) => m.name)
      return {
        view: 'overview',
        profile: {
          name: doc.info.nameZh,
          grade: doc.info.grade ?? undefined,
          education: doc.info.education?.nameZh ?? undefined,
          department: doc.info.department?.nameZh ?? undefined,
          major: doc.info.major?.nameZh ?? undefined,
          cultivateType: doc.info.cultivateType?.nameZh ?? undefined,
          printedTime: doc.info.printedTime ?? undefined,
        },
        credits,
        courseCount: doc.courses.length,
        topModules,
        tip: '学分明细看 view=modules，课程清单看 view=courses，和本批次开课逐门对照看 view=crosscheck。',
      }
    },
  }),

  /* ─────────────── 2. 预约 ─────────────── */
  defineTool({
    name: 'campus_reserve',
    group: 'campus',
    label: '预约抢课',
    description:
      '**预约**：把商量好的课提前落成抢课计划 —— 一句模糊查询 = 一门课（课名 / 课程代码 / 教师，空格分词，' +
      '打全了教师名就是「只要这位老师的班」）。落库后引擎在能看见名单时自己解析成志愿任务、守着窗口开火，' +
      '同一个批次里每门课只中一个班。' +
      '**dryRun 默认 true：只出预约单不落库** —— 先用它把「会抢哪些班、还剩多少位置、什么时候开抢、' +
      '有没有不在培养方案里的」拿给用户看，用户点头后再用 dryRun:false 真排。' +
      '批次还没公布时预览会说明「等窗口」，而**预约照样能落库**：引擎每分钟看一次窗口，一出现就自己排班。',
    parameters: Type.Object({
      queries: Type.Array(Type.String(), {
        description: '每项一句模糊查询 = 想抢的一门课，如 ["体育", "大学英语 王芳"]',
      }),
      turnId: Type.Optional(Type.String({ description: '批次 id，不传 = 教务当前开放的那个' })),
      mode: Type.Optional(
        Type.Union([Type.Literal('predicate'), Type.Literal('direct')], {
          description: 'predicate = 先占位再正式提交（推荐，也是默认）；direct = 直接提交',
        }),
      ),
      spread: Type.Optional(
        Type.Boolean({
          description:
            'true = 一句查询命中多门课时每门各排一组（可能中好几门）；默认 false = 全部命中合成一组，只中一个',
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: 'true（默认）= 只出预约单；false = 真的落库' }),
      ),
    }),
    async execute(args) {
      const queries = [...new Set((args.queries ?? []).map((q) => q.trim()).filter(Boolean))]
      if (!queries.length) {
        throw new Error('要给出至少一句「想抢什么」：课名 / 课程代码 / 教师名，空格分词（如「体育」「高数 张伟」）')
      }
      const mode = args.mode ?? 'predicate'
      const spread = args.spread ?? false

      /* 落库：一句查询 = 一条计划。计划不抢，抢是引擎的事 —— 窗口一开它自己出手 */
      if (args.dryRun === false) {
        const reserved: unknown[] = []
        for (const q of queries) {
          const intent = await campusService.grabIntentAdd({
            query: q,
            turnId: args.turnId ?? null,
            mode,
            spread,
          })
          reserved.push({
            id: intent.id,
            query: q,
            status: intent.status,
            lastMessage: intent.lastMessage ?? undefined,
          })
        }
        await note('grab', `预约了 ${queries.length} 门课`, { queries, mode, spread, reserved })
        return {
          dryRun: false,
          reserved,
          message:
            '已落库成抢课计划。引擎接下来会：等批次公布 → 照当时的名单解析出教学班 → 排成志愿任务 → ' +
            '窗口一开就出手（满员会自己守着名额）。抢课那几天别把 App 从后台清掉，清了引擎就停了。',
          next: '用 campus_status 看解析结果（intents 里会列出命中的班），要改要撤就用 campus_grab_control 的 intent 动作。',
        }
      }

      /* 预约单：先摆事实，不落库。培养方案拉不到也照样出单（只是少一列「在不在方案里」） */
      const doc = await loadProgram(false).catch(() => null)
      const items: unknown[] = []
      for (const q of queries) {
        try {
          const p = await campusService.grabIntentPreview(q, args.turnId ?? null)
          const picks = p.matches.slice(0, 8).map((m) => matchDigest(m, doc))
          items.push({
            query: q,
            turn: p.turnName ?? p.turnId,
            /** 这个批次教务一共给了多少教学班 —— 用来分清「教务还没公布」与「没匹配上」 */
            turnTotal: p.total,
            matched: p.matched,
            /** 真会抢的那些班，顺序就是志愿序；这里只给前几个，`hidden` 是没列出的条数 */
            picks,
            hidden: Math.max(0, p.matches.length - 8),
            /**
             * 命中的班在不在培养方案里的**汇总**（逐条看 `picks[].inProgram`）。
             * 只看第一个班是不行的：同一句查询命中的班里可能既有方案内的、也有方案外的。
             */
            program: doc
              ? {
                  inProgram: picks.filter((p) => p.inProgram).length,
                  outside: picks.filter((p) => p.inProgram === false).length,
                }
              : undefined,
          })
        } catch (e) {
          items.push({
            query: q,
            error: e instanceof Error ? e.message : String(e),
            hint: '教务还没公布批次时预览必然失败，这是正常的：预约照样能落库，引擎会每分钟看一次窗口，出现后自己排班开抢。',
          })
        }
      }

      // 窗口：教务自己说有哪几个批次；没有就说明还没公布
      const status = await campusService.courseSelectStatus().catch(() => null)
      const turns = (status?.turns ?? []).map((t) => ({
        id: idOf(t.id),
        name: t.name ?? undefined,
        allowEnter: t.allowEnter ?? false,
        ...turnWindow(t),
      }))
      const account = await campusService.accountGet().catch(() => null)
      const openNow = turns.some((t) => t.allowEnter)

      return {
        dryRun: true,
        window: {
          turns,
          openNow,
          note: openNow
            ? '窗口正开着：落库后引擎会立刻解析名单并出手。'
            : '教务现在没公布任何批次（大一没到窗口时就是这样）。**这不影响预约**：计划先落库，引擎每分钟看一次窗口，一出现就自己排班开抢。',
        },
        items,
        programChecked: !!doc,
        credits: doc
          ? {
              required: doc.required,
              earned: account?.totalCredits ?? null,
              missing:
                doc.required != null && account?.totalCredits != null
                  ? Math.max(0, doc.required - account.totalCredits)
                  : undefined,
            }
          : undefined,
        next: '把上面这几行**念给用户核对**（抢哪几门、备选班与教师、有没有 full / 不在培养方案里的），拿到一句明确同意后再用 dryRun:false 落库 —— 没经同意别落库。',
      }
    },
  }),
]
