/**
 * 方案 setup 阶段的展示辅助：三档对比矩阵 / 4 周强度预览 / 约束即时预览。
 *
 * 全部为纯函数：输入引擎产出的 ProgramPlan 或用户约束，输出展示结构；
 * 不发 IPC、不改状态，便于在组件外独立验证。
 */

import { EQUIPMENT_LABELS } from '@/config/domain'
import type { Goal, ProgramPlan, ProgramTier } from '@/types'
import { pickWeekTemplate, weekMuscleFreq } from './programEngine'

/** 约束快照：判断「草稿生成后约束又改过」用（含开始日与首练选择——同样要求重算） */
export interface ConstraintSnapshot {
  trainingDaysPerWeek: number
  equipment: string
  timeSlots: string[]
  restrictions: string[]
  /** 方案开始：next=下周一（默认）/ today / tomorrow */
  startMode: string
  /** 首个训练日课程 id；null = 按模板默认顺序 */
  firstCourseId: string | null
}

export function constraintSnapshotOf(
  p: {
    trainingDaysPerWeek: number | null
    equipment: string | null
    preferredTimeSlots: string[] | null
    dietRestrictions: string[] | null
  },
  start: { startMode: string; firstCourseId: string | null } = { startMode: 'next', firstCourseId: null },
): ConstraintSnapshot {
  return {
    trainingDaysPerWeek: p.trainingDaysPerWeek ?? 4,
    equipment: p.equipment ?? 'gym',
    timeSlots: [...(p.preferredTimeSlots ?? [])],
    restrictions: [...(p.dietRestrictions ?? [])],
    startMode: start.startMode,
    firstCourseId: start.firstCourseId,
  }
}

export function sameConstraint(a: ConstraintSnapshot, b: ConstraintSnapshot): boolean {
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i])
  return (
    a.trainingDaysPerWeek === b.trainingDaysPerWeek &&
    a.equipment === b.equipment &&
    eq(a.timeSlots, b.timeSlots) &&
    eq(a.restrictions, b.restrictions) &&
    a.startMode === b.startMode &&
    a.firstCourseId === b.firstCourseId
  )
}

/* ---------------- 01 · 对比矩阵 ---------------- */

/** 月度预期变化（kg）：缺口 × 30 天 ÷ 7700 大卡/kg，保留 1 位（cut 为负） */
export function monthlyDeltaKg(plan: ProgramPlan): number {
  return Math.round(((plan.params.kcalDelta * 30) / 7700) * 10) / 10
}

export interface MatrixRow {
  label: string
  /** 每档的展示值（下标与 PROGRAM_TIERS 对应） */
  values: string[]
  /** 结果行（月度变化）视觉加重 */
  strong?: boolean
}

export function matrixRows(plans: ProgramPlan[]): MatrixRow[] {
  const by = (t: ProgramTier): ProgramPlan => plans.find((p) => p.tier === t)!
  const ordered: ProgramPlan[] = [
    by('conservative'),
    by('balanced'),
    by('aggressive'),
  ].filter(Boolean)
  return [
    {
      label: '每日热量',
      values: ordered.map((p) => `${Math.round(p.params.targets.kcal)}`),
    },
    {
      label: '蛋白质',
      values: ordered.map((p) => `${Math.round(p.params.targets.protein)}g`),
    },
    {
      label: '每周训练',
      values: ordered.map((p) => `${p.params.trainingDays}天`),
    },
    {
      // 研究里的「最佳频次」指同一肌群每周被练到的次数，单独一行让分化设计可见
      label: '每肌群频次',
      values: ordered.map((p) => {
        const f = weekMuscleFreq(p.params.weekTemplateId)
        return f == null ? '—' : `${f} 次/周`
      }),
    },
    {
      label: '每日餐次',
      values: ordered.map((p) => `${p.params.mealsCount}餐`),
    },
    {
      label: '预计月变化',
      values: ordered.map((p) => {
        const kg = monthlyDeltaKg(p)
        return `${kg > 0 ? '+' : ''}${kg}kg`
      }),
      strong: true,
    },
  ]
}

export interface TierDiff {
  title: string
  text: string
}

/**
 * 相邻档位差异解说：选保守 → 与均衡比；选均衡/进取 → 与进取比。
 * 一句话讲清「多付出什么、换回什么」。
 */
export function tierDiffText(plans: ProgramPlan[], selected: ProgramTier, goal: Goal): TierDiff | null {
  const by = (t: ProgramTier) => plans.find((p) => p.tier === t)
  const a = selected === 'conservative' ? by('conservative') : by('balanced')
  const b = selected === 'conservative' ? by('balanced') : by('aggressive')
  if (!a || !b || !a.feasible || !b.feasible) return null

  const kcalGap = b.params.kcalDelta - a.params.kcalDelta // 负 = b 吃得更少
  const proteinGap = Math.round(b.params.targets.protein - a.params.targets.protein)
  const dayGap = b.params.trainingDays - a.params.trainingDays
  const kgGap = Math.round((monthlyDeltaKg(b) - monthlyDeltaKg(a)) * 10) / 10
  const verb = goal === 'bulk' ? '增重' : '减重'

  const parts: string[] = []
  if (kcalGap !== 0) {
    parts.push(
      kcalGap < 0
        ? `${b.tierLabel}每天再少吃 ${Math.abs(kcalGap)} 大卡`
        : `${b.tierLabel}每天多吃 ${kcalGap} 大卡`,
    )
  }
  if (dayGap !== 0) parts.push(`每周${dayGap > 0 ? '多' : '少'}练 ${Math.abs(dayGap)} 天`)
  if (proteinGap !== 0) parts.push(`蛋白${proteinGap > 0 ? '多' : '少'} ${Math.abs(proteinGap)}g`)
  if (!parts.length) return { title: `${a.tierLabel} vs ${b.tierLabel}`, text: '两档结构一致，差异只在心理预期。' }

  const effect =
    kgGap === 0
      ? '月度变化接近'
      : `换来每月多${verb === '增重' ? '增' : '减'} ${Math.abs(kgGap)}kg`
  return {
    title: `${a.tierLabel} vs ${b.tierLabel}`,
    text: `${parts.join('、')}，${effect}。`,
  }
}

/** 每档的「适合谁」：静态文案，与 TIER_SPECS 的档位性格对应 */
export function tierFitText(tier: ProgramTier, goal: Goal): string {
  const v = goal === 'bulk' ? '在 3 个月内干净增重 2–3kg' : goal === 'keep' ? '稳住体重与体态' : '在 3 个月内减 4–6kg'
  if (tier === 'conservative')
    return `第一次执行方案、日程多变或怕饿的人；${v}，节奏最宽容。`
  if (tier === 'balanced')
    return `有固定作息、每周能稳定训练 4 天、想${v}且不牺牲社交聚餐的人。`
  return `执行力强、能保证睡眠与备餐的人；${v}，需要扛住更大的饮食缺口。`
}

/* ---------------- 02 · 强度预览 ---------------- */

export interface PreviewCell {
  date: string
  /** 课程缩写（1 字），休息日为 null */
  label: string | null
  rest: boolean
  /** 课程时长（分钟）；休息日 null */
  min: number | null
}

export interface PreviewWeek {
  /** 「第 1 周」 */
  label: string
  cells: PreviewCell[]
  /** 本周训练总时长（分钟） */
  totalMin: number
}

/** 课程名 → 1 字缩写（格子太小）：居家前缀剥掉后取首字（全身循环→全） */
export function courseShort(name: string): string {
  return name.replace(/^居家/, '').charAt(0)
}

/** 按 7 天一组切周（blob.days 已按天序排列） */
export function weekPreview(plan: ProgramPlan): PreviewWeek[] {
  const out: PreviewWeek[] = []
  for (let i = 0; i < plan.days.length; i += 7) {
    const days = plan.days.slice(i, i + 7)
    out.push({
      label: `第 ${out.length + 1} 周`,
      cells: days.map((d) => ({
        date: d.date,
        label: d.courseName ? courseShort(d.courseName) : null,
        rest: d.rest,
        min: d.courseDurationMin,
      })),
      totalMin: days.reduce((s, d) => s + (d.rest ? 0 : (d.courseDurationMin ?? 0)), 0),
    })
  }
  return out
}

/** 强度节奏解说：找出最累周与减量周，翻译成一句话 */
export function rhythmText(weeks: PreviewWeek[]): string {
  if (!weeks.length) return ''
  const totals = weeks.map((w) => w.totalMin)
  const peak = totals.indexOf(Math.max(...totals))
  const last = totals.length - 1
  const peakMin = totals[peak]!
  const parts: string[] = []
  if (peak > 0 && peak < last) {
    parts.push(`第 ${peak + 1} 周总量最高（约 ${peakMin} 分钟）`)
  } else if (peak === last && peak > 0) {
    parts.push(`强度逐周爬升，第 ${peak + 1} 周达到 ${peakMin} 分钟`)
  }
  if (last > 0 && totals[last]! < peakMin * 0.8) {
    const drop = Math.round((1 - totals[last]! / peakMin) * 100)
    parts.push(`最后一周主动减量 ${drop}% 让身体恢复`)
  }
  if (!parts.length) parts.push('四周节奏平稳，没有极端周')
  return `${parts.join('，')}——这不是偷懒，是计划的一部分。`
}

/* ---------------- 03 · 约束即时预览 ---------------- */

/**
 * 约束 → 一行即时反馈（与生成结果同口径：pickWeekTemplate）。
 * 例：「4 练 · 健身房 · 四练 · 推拉腿加核心」。
 */
export function constraintSummary(trainingDays: number, equipment: string): string {
  const eq = EQUIPMENT_LABELS[equipment] ?? equipment
  const tpl = pickWeekTemplate(equipment === 'home' ? 'home' : 'gym', trainingDays)
  const dayText = trainingDays === 0 ? '纯饮食' : `${trainingDays} 练`
  return `${dayText} · ${eq} · ${tpl.label}`
}

/** 高频约束的当场提醒（而不是等生成后才发现扛不住） */
export function constraintWarning(trainingDays: number): string | null {
  if (trainingDays >= 6) return '每周 6 练以上对睡眠和备餐要求很高，首次执行建议 3–5 练。'
  if (trainingDays === 0) return '不安排训练日时方案只管饮食，热量目标仍会生效。'
  return null
}
