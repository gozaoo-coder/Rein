/** 记账域类型 · 与 Rust `modules/ledger` 对应。金额一律整数分。 */

export type LedgerKind = 'expense' | 'income'

export interface LedgerEntry {
  id: number
  kind: LedgerKind
  /** 分类 key（src/config/ledger.ts） */
  category: string
  /** 金额（分），恒为正；正负由 kind 表达 */
  amountCents: number
  note: string | null
  /** YYYY-MM-DD */
  date: string
  createdAt: string
}

export interface LedgerEntryInput {
  kind: LedgerKind
  category: string
  amountCents: number
  note?: string | null
  date: string
}

export interface LedgerSettings {
  id: number
  /** 0 = 未设置月度总预算 */
  monthlyBudgetCents: number
  updatedAt: string | null
}
