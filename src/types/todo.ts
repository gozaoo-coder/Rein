/**
 * TodoList — 待办事项类型定义
 *
 * 支持的待办形态：
 * - 普通待办（kind=all-day / deadline / time-range）
 * - 循环待办（recurrence：每日/每周/每月/自定义星期）
 * - 每日打卡（recurrence=daily 且 checkin=true）
 * - 子任务（subtasks 列表，每项有独立完成状态）
 *
 * 待办可挂载分类（categoryId）、地点（location）、紧急度（urgent，
 * 与优先级 priority 正交，用于四象限视图）。
 */

export type TodoPriority = "low" | "normal" | "high";

/** 待办类型 */
export type TodoKind = "all-day" | "deadline" | "time-range";

/** 循环规则 */
export interface TodoRecurrence {
  /** daily / weekly / monthly / weekdays（周一到周五）/ custom */
  type: "daily" | "weekly" | "monthly" | "weekdays" | "custom";
  /** 当 type=custom 时，按周几数组（0=周日..6=周六） */
  daysOfWeek?: number[];
  /** 每月几号（仅 monthly） */
  dayOfMonth?: number;
  /** 间隔（每 N 个单位），默认 1 */
  interval?: number;
  /** 结束日期 YYYY-MM-DD（可选） */
  until?: string;
}

/** 子任务 */
export interface TodoSubtask {
  id: string;
  title: string;
  done: boolean;
  /** 子任务可附数量范围（如"做10~15页"） */
  countMin?: number;
  countMax?: number;
  /** 当前已完成数量（用于打卡式子任务） */
  countDone?: number;
  unit?: string;
}

/** 待办分类 */
export interface TodoCategory {
  id: string;
  name: string;
  /** emoji 或图标名（前端约定） */
  icon: string;
  /** 颜色 token（css 变量名或具体色值） */
  color?: string;
  /** 是否预置（不可删除） */
  preset?: boolean;
  createdAt: number;
}

export interface TodoItem {
  id: string;
  title: string;
  note?: string;

  /** 待办形态 */
  kind: TodoKind;
  /** 截止日期 YYYY-MM-DD（按本地时区）；all-day 也使用此字段 */
  dueDate?: string;
  /** 截止时间 HH:mm（仅 deadline / time-range） */
  dueTime?: string;
  /** 时间段开始 HH:mm（仅 time-range） */
  startTime?: string;
  /** 时间段结束 HH:mm（仅 time-range） */
  endTime?: string;

  /** 循环规则（可选，无则单次待办） */
  recurrence?: TodoRecurrence;
  /** 是否为每日打卡（用于 UI 标记 + 打卡式完成） */
  checkin?: boolean;

  /** 子任务 */
  subtasks?: TodoSubtask[];

  /** 地点（自由文本或地名） */
  location?: string;

  /** 优先级（重要度，影响排序） */
  priority: TodoPriority;
  /** 紧急度（与 priority 正交，用于四象限视图） */
  urgent?: boolean;

  /** 所属分类 ID（不挂则为 "default"） */
  categoryId?: string;

  done: boolean;
  /** 完成时间戳，未完成为 0 */
  completedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type CalendarView = "month" | "week";

/** 待办列表页主视图模式 */
export type TodoListView = "calendar" | "quadrant" | "category";

/** 日期单元格元数据 */
export interface DayMeta {
  /** YYYY-MM-DD */
  date: string;
  day: number;
  /** 是否当月（仅月视图 relevant） */
  inMonth: boolean;
  isToday: boolean;
  /** 该日待办数量 */
  todoCount: number;
  /** 该日已完成数量 */
  doneCount: number;
  /** 进度（0-1） */
  progress: number;
  /** 是否休息日（周六/周日） */
  isWeekend: boolean;
  /** 是否节假日（来自 preset 列表） */
  isHoliday: boolean;
  /** 节假日名称 */
  holidayName?: string;
}

/** 节假日预设 */
export interface HolidayPreset {
  date: string; // MM-DD（年度重复）或 YYYY-MM-DD（单次）
  name: string;
  type: "public" | "rest";
}

/** 默认节假日预设（中国公历节日 + 周末标记） */
export const HOLIDAY_PRESETS: HolidayPreset[] = [
  { date: "01-01", name: "元旦", type: "public" },
  { date: "02-14", name: "情人节", type: "public" },
  { date: "03-08", name: "妇女节", type: "public" },
  { date: "05-01", name: "劳动节", type: "public" },
  { date: "05-04", name: "青年节", type: "public" },
  { date: "06-01", name: "儿童节", type: "public" },
  { date: "07-01", name: "建党节", type: "public" },
  { date: "08-01", name: "建军节", type: "public" },
  { date: "09-10", name: "教师节", type: "public" },
  { date: "10-01", name: "国庆节", type: "public" },
  { date: "12-25", name: "圣诞节", type: "public" },
];

export const PRIORITY_LABEL: Record<TodoPriority, string> = {
  low: "低",
  normal: "中",
  high: "高",
};

export const TODO_KIND_LABEL: Record<TodoKind, string> = {
  "all-day": "整日",
  deadline: "截止时间",
  "time-range": "时间段",
};

export const RECURRENCE_LABEL: Record<TodoRecurrence["type"], string> = {
  daily: "每日",
  weekly: "每周",
  monthly: "每月",
  weekdays: "工作日",
  custom: "自定义",
};

/** 默认分类（preset，不可删除） */
export const DEFAULT_CATEGORIES: TodoCategory[] = [
  { id: "default", name: "默认", icon: "📋", preset: true, createdAt: 0 },
  { id: "work", name: "工作", icon: "💼", preset: true, createdAt: 0 },
  { id: "study", name: "学习", icon: "📚", preset: true, createdAt: 0 },
  { id: "fitness", name: "健身", icon: "💪", preset: true, createdAt: 0 },
  { id: "life", name: "生活", icon: "🏠", preset: true, createdAt: 0 },
];

/** 四象限分组键 */
export type QuadrantKey = "q1" | "q2" | "q3" | "q4";

export const QUADRANT_LABEL: Record<QuadrantKey, string> = {
  q1: "重要 · 紧急",
  q2: "重要 · 不紧急",
  q3: "不重要 · 紧急",
  q4: "不重要 · 不紧急",
};

export const QUADRANT_HINT: Record<QuadrantKey, string> = {
  q1: "立即做",
  q2: "计划做",
  q3: "委托/快速做",
  q4: "尽量减少",
};

/** 由 priority + urgent 计算四象限 */
export function quadrantOf(item: TodoItem): QuadrantKey {
  const important = item.priority === "high";
  const urgent = !!item.urgent;
  if (important && urgent) return "q1";
  if (important && !urgent) return "q2";
  if (!important && urgent) return "q3";
  return "q4";
}

/** 判断待办是否对指定日期生效（考虑循环） */
export function todoActiveOnDate(item: TodoItem, dateKey: string): boolean {
  if (!item.recurrence) {
    return item.dueDate === dateKey;
  }
  const target = parseDateKey(dateKey);
  const start = item.dueDate ? parseDateKey(item.dueDate) : null;
  if (start && target < start) return false;
  if (item.recurrence.until) {
    const until = parseDateKey(item.recurrence.until);
    if (target > until) return false;
  }
  const r = item.recurrence;
  const interval = r.interval ?? 1;
  if (r.type === "daily") {
    if (!start) return true;
    const days = Math.round((target.getTime() - start.getTime()) / 86400000);
    return days >= 0 && days % interval === 0;
  }
  if (r.type === "weekdays") {
    const dow = target.getDay();
    if (dow === 0 || dow === 6) return false;
    if (!start) return true;
    const days = Math.round((target.getTime() - start.getTime()) / 86400000);
    return days >= 0;
  }
  if (r.type === "weekly") {
    const dow = target.getDay();
    if (!start) return true;
    const startDow = start.getDay();
    const days = Math.round((target.getTime() - start.getTime()) / 86400000);
    const weekDiff = Math.floor(days / 7);
    if (weekDiff % interval !== 0) return false;
    return dow === startDow;
  }
  if (r.type === "monthly") {
    if (r.dayOfMonth != null && target.getDate() !== r.dayOfMonth) return false;
    if (!start) return true;
    const months =
      (target.getFullYear() - start.getFullYear()) * 12 +
      (target.getMonth() - start.getMonth());
    return months >= 0 && months % interval === 0;
  }
  if (r.type === "custom") {
    const dow = target.getDay();
    return (r.daysOfWeek ?? []).includes(dow);
  }
  return false;
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
