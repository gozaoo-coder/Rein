/**
 * Card system — 主页可编辑卡片
 *
 * 网格：4 列基础网格，行高自适应
 * 尺寸：1x1 / 2x1 / 2x2 / 4x2 (宽×高，单位为网格格)
 */

export type CardSize = "1x1" | "2x1" | "2x2" | "4x2";

/** 卡片类型枚举 — 所有支持的卡片种类 */
export type CardType =
  | "three-ring" // 三环数据（无边框独立卡）
  | "health-overview" // 健康概览（BMI/身体指标）
  | "today-todo" // 今日待办
  | "important-todo" // 重要待办
  | "urgent-todo" // 紧急待办
  | "recent-workout" // 最近运动
  | "water-record" // 饮水记录
  | "water-quick-add" // 快速记水（1x1/2x1，只做快速加）
  | "food-record" // 记录食物
  | "weight-record"; // 体重记录

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
  /** 显式网格位置（1-based）。未设置时由 packer 自动分配 */
  col?: number;
  row?: number;
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
  title: string;
  description: string;
  sizes: CardSize[];
  defaultSize: CardSize;
  accent: string;
  icon: string;
}

export const CARD_REGISTRY: Record<CardType, CardMeta> = {
  "three-ring": {
    type: "three-ring",
    title: "三环数据",
    description: "活动/运动/站立三环进度",
    sizes: ["4x2"],
    defaultSize: "4x2",
    accent: "var(--color-warm)",
    icon: "bullseye",
  },
  "health-overview": {
    type: "health-overview",
    title: "健康概览",
    description: "BMI 等健康指标",
    sizes: ["2x1", "2x2"],
    defaultSize: "2x2",
    accent: "var(--color-warm)",
    icon: "heart-fill",
  },
  "today-todo": {
    type: "today-todo",
    title: "今日待办",
    description: "今日待办完成进度",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x2",
    accent: "var(--icon-orange)",
    icon: "check-lg",
  },
  "important-todo": {
    type: "important-todo",
    title: "重要待办",
    description: "高优先级待办事项",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x1",
    accent: "var(--warning-500)",
    icon: "star-fill",
  },
  "urgent-todo": {
    type: "urgent-todo",
    title: "紧急待办",
    description: "今日截止紧急任务",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x1",
    accent: "var(--danger-500)",
    icon: "exclamation-triangle-fill",
  },
  "recent-workout": {
    type: "recent-workout",
    title: "最近运动",
    description: "7 日训练强度 + 最近记录",
    sizes: ["2x2", "4x2"],
    defaultSize: "2x2",
    accent: "var(--color-warm)",
    icon: "activity",
  },
  "water-record": {
    type: "water-record",
    title: "饮水记录",
    description: "今日饮水进度 + 快速记录",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x1",
    accent: "var(--icon-blue)",
    icon: "droplet-fill",
  },
  "water-quick-add": {
    type: "water-quick-add",
    title: "快速记水",
    description: "点按数字直接记录饮水量",
    sizes: ["1x1", "2x1"],
    defaultSize: "2x1",
    accent: "var(--icon-blue)",
    icon: "cup-straw",
  },
  "food-record": {
    type: "food-record",
    title: "记录食物",
    description: "今日热量 + 三大营养素",
    sizes: ["1x1", "2x1", "2x2"],
    defaultSize: "2x2",
    accent: "var(--success-500)",
    icon: "apple",
  },
  "weight-record": {
    type: "weight-record",
    title: "体重",
    description: "当前体重与历史趋势",
    sizes: ["2x1", "2x2", "4x2"],
    defaultSize: "2x1",
    accent: "var(--icon-purple)",
    icon: "speedometer2",
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
