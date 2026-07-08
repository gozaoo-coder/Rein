/**
 * Card system — 主页可编辑卡片
 *
 * 网格：4 列基础网格，行高自适应
 * 尺寸：1x1 / 2x1 / 2x2 / 4x2 (宽×高，单位为网格格)
 */

export type CardSize = "1x1" | "2x1" | "2x2" | "4x2";

/** 卡片类型枚举 — 所有支持的卡片种类 */
export type CardType =
  | "health-overview" // 健康概览（卡路里/步数/BMI 等）
  | "today-todo" // 今日待办
  | "important-todo" // 重要待办
  | "urgent-todo" // 紧急待办
  | "recent-workout" // 最近运动
  | "water-record" // 饮水记录
  | "food-record"; // 记录食物

/** 环形图可选数据源 */
export type RingDataSource =
  | "calories" // 饮食热量
  | "steps" // 步数
  | "exercise" // 运动分钟
  | "todo-progress" // 待办完成度
  | "water" // 饮水
  | "bmi"; // BMI 进度

export interface CardConfig {
  /** 实例 id（同一类型可多实例） */
  id: string;
  type: CardType;
  size: CardSize;
  /** 自定义 props */
  props?: Record<string, any>;
}

export interface CardLayout {
  cards: CardConfig[];
  /** 网格列数（固定 4） */
  columns: number;
  /** 三环数据源配置 [外环, 中环, 内环] */
  rings: RingDataSource[];
}

export const CARD_SIZE_MAP: Record<CardSize, { cols: number; rows: number }> = {
  "1x1": { cols: 1, rows: 1 },
  "2x1": { cols: 2, rows: 1 },
  "2x2": { cols: 2, rows: 2 },
  "4x2": { cols: 4, rows: 2 },
};

/** 卡片元信息 — 注册表 */
export interface CardMeta {
  type: CardType;
  /** 显示名 */
  title: string;
  /** 简短描述 */
  description: string;
  /** 支持的尺寸 */
  sizes: CardSize[];
  /** 默认尺寸 */
  defaultSize: CardSize;
  /** 主题色（用于图标背景） */
  accent: string;
  /** 图标 svg path (24x24 viewBox) */
  icon: string;
}

export const CARD_REGISTRY: Record<CardType, CardMeta> = {
  "health-overview": {
    type: "health-overview",
    title: "健康概览",
    description: "卡路里 / 步数 / BMI 等综合数据",
    sizes: ["2x2", "4x2"],
    defaultSize: "2x2",
    accent: "var(--color-warm)",
    icon: "M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z",
  },
  "today-todo": {
    type: "today-todo",
    title: "今日待办",
    description: "今日待办完成进度",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x2",
    accent: "var(--icon-orange)",
    icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  },
  "important-todo": {
    type: "important-todo",
    title: "重要待办",
    description: "高优先级待办事项",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x1",
    accent: "var(--warning-500)",
    icon: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  },
  "urgent-todo": {
    type: "urgent-todo",
    title: "紧急待办",
    description: "今日截止紧急任务",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x1",
    accent: "var(--danger-500)",
    icon: "M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z",
  },
  "recent-workout": {
    type: "recent-workout",
    title: "最近运动",
    description: "7 日训练强度 + 最近记录",
    sizes: ["2x2", "4x2"],
    defaultSize: "2x2",
    accent: "var(--color-warm)",
    icon: "M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM10 21l2-6 3 2 3-5-3-1-3 3-3-1-3 5z",
  },
  "water-record": {
    type: "water-record",
    title: "饮水记录",
    description: "今日饮水进度 + 快速记录",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x1",
    accent: "var(--icon-blue)",
    icon: "M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z",
  },
  "food-record": {
    type: "food-record",
    title: "记录食物",
    description: "今日热量 + 三大营养素",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x2",
    accent: "var(--success-500)",
    icon: "M3 11h18l-2 9a2 2 0 0 1-2 1.7H7a2 2 0 0 1-2-1.7L3 11zM7 11V8a5 5 0 0 1 10 0v3",
  },
};

export const ALL_CARD_TYPES: CardType[] = Object.keys(CARD_REGISTRY) as CardType[];

/** 环数据源显示名 */
export const RING_DATA_LABEL: Record<RingDataSource, string> = {
  calories: "饮食热量",
  steps: "步数",
  exercise: "运动分钟",
  "todo-progress": "待办完成度",
  water: "饮水",
  bmi: "BMI",
};

export const DEFAULT_RINGS: RingDataSource[] = ["todo-progress", "steps", "calories"];
