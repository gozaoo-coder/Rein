/** 重复规则工具 · 与 Rust sync_recurrences 同语义（mock 端共用） */

import { diffDays, parseDate } from '@/utils/date'
import type { RecRule } from '@/types'

/** 周一 = 0 … 周日 = 6 */
export function dowOf(date: string): number {
  return (parseDate(date).getDay() + 6) % 7
}

/** date 是否命中规则（templateDate 为模板自身日期，即首个实例日） */
export function ruleMatchesDate(rule: RecRule, templateDate: string, date: string): boolean {
  if (rule.endDate && date > rule.endDate) return false
  if (date < templateDate) return false
  if (rule.freq === 'daily') return true
  if (rule.freq === 'weekly') return rule.weekdays.includes(dowOf(date))
  if (rule.freq === 'interval') {
    // 复用 diffDays（UTC 日历日），与 Rust NaiveDate 相减保持等价
    return rule.intervalDays > 0 && diffDays(templateDate, date) % rule.intervalDays === 0
  }
  return false
}

const WD = ['一', '二', '三', '四', '五', '六', '日']

/** 规则的一句话描述（编辑器与详情共用） */
export function describeRule(rule: RecRule): string {
  if (rule.freq === 'daily') return '每天'
  if (rule.freq === 'weekly') {
    const ds = [...rule.weekdays].sort((a, b) => a - b).map((d) => WD[d] ?? '?')
    return ds.length ? `每周${ds.join('、')}` : '每周'
  }
  if (rule.freq === 'interval') return `每 ${rule.intervalDays} 天`
  return '重复'
}
