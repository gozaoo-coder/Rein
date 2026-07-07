export type CardSize = "1x1" | "1x2" | "2x1" | "2x2" | "2x4";

export interface CardConfig {
  id: string;
  component: string;
  size: CardSize;
  editable: boolean;
  props: Record<string, any>;
}

export interface CardLayout {
  cards: CardConfig[];
  columns: number;
}

export const CARD_SIZE_MAP: Record<CardSize, { cols: number; rows: number }> = {
  "1x1": { cols: 1, rows: 1 },
  "1x2": { cols: 1, rows: 2 },
  "2x1": { cols: 2, rows: 1 },
  "2x2": { cols: 2, rows: 2 },
  "2x4": { cols: 2, rows: 4 },
};
