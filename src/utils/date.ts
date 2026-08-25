/** 本地时区日期工具。约定：全应用日期一律用 `YYYY-MM-DD` 字符串传递。 */

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

export function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayStr(): string {
  return toDateStr(new Date())
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return toDateStr(d)
}

/** 两个 YYYY-MM-DD 相差天数（b − a，可负） */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000)
}

/** 周一为一周起点 */
export function startOfWeek(s: string): string {
  const d = parseDate(s)
  const dow = (d.getDay() + 6) % 7 // 周一=0 … 周日=6
  d.setDate(d.getDate() - dow)
  return toDateStr(d)
}

/** YYYY-MM-DD → 当月首日 */
export function startOfMonth(s: string): string {
  return `${s.slice(0, 7)}-01`
}

/** YYYY-MM-DD → 当月末日 */
export function endOfMonth(s: string): string {
  const d = parseDate(startOfMonth(s))
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}

/** 月份加减：YYYY-MM-DD → ±n 月后的同一日期（月末自动钳制） */
export function addMonths(s: string, n: number): string {
  const d = parseDate(startOfMonth(s))
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(parseDate(s).getDate(), last))
  return toDateStr(d)
}

/** 月份 key：YYYY-MM */
export function monthKey(s: string): string {
  return s.slice(0, 7)
}

export function weekDates(s: string): string[] {
  const start = startOfWeek(s)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

export interface MonthCell {
  date: string | null
  day: number
}

/** 月历网格：周一开头，6 行 × 7 列，非本月格子 date 为 null */
export function monthGrid(year: number, month: number): MonthCell[] {
  const first = new Date(year, month - 1, 1)
  const lead = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells: MonthCell[] = []
  for (let i = 0; i < lead; i++) cells.push({ date: null, day: 0 })
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: toDateStr(new Date(year, month - 1, d)), day: d })
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, day: 0 })
  return cells
}

export function fmtDateCn(s: string): string {
  const d = parseDate(s)
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY_LABELS[(d.getDay() + 6) % 7]}`
}

export function fmtMonthTitle(year: number, month: number): string {
  return `${year}年${month}月`
}

/** 分钟数 → HH:mm */
export function minToHHmm(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function nowMin(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

/** 由生日换算周岁；生日为空或非法时返回 null */
export function ageFromBirthday(birthday: string | null): number | null {
  if (!birthday) return null
  const d = parseDate(birthday)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const beforeBirthday =
    now.getMonth() < d.getMonth() ||
    (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())
  if (beforeBirthday) age -= 1
  return age >= 0 && age < 150 ? age : null
}
