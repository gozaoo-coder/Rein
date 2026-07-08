/**
 * TodoList — 待办事项类型定义
 *
 * 支持：
 * - 标题、备注、优先级、截止日期
 * - 完成状态、创建/更新时间
 * - 持久化到 Tauri storage
 */

export type TodoPriority = "low" | "normal" | "high";

export interface TodoItem {
  id: string;
  title: string;
  note?: string;
  /** 截止日期 YYYY-MM-DD（按本地时区） */
  dueDate?: string;
  priority: TodoPriority;
  done: boolean;
  /** 完成时间戳，未完成为 0 */
  completedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type CalendarView = "month" | "week";

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
