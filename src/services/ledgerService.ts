/** 记账域 IPC 封装 · 对应 modules/ledger/commands.rs */

import type { LedgerEntry, LedgerEntryInput, LedgerSettings } from '@/types'
import { invoke } from './transport'

export const ledgerService = {
  listLedgerEntries: (startDate: string, endDate: string, category?: string | null, keyword?: string | null) =>
    invoke<LedgerEntry[]>('list_ledger_entries', { startDate, endDate, category, keyword }),

  createLedgerEntry: (input: LedgerEntryInput) => invoke<LedgerEntry>('create_ledger_entry', { input }),

  updateLedgerEntry: (entry: LedgerEntry) => invoke<LedgerEntry>('update_ledger_entry', { entry }),

  deleteLedgerEntry: (id: number) => invoke<void>('delete_ledger_entry', { id }),

  getLedgerBudget: () => invoke<LedgerSettings>('get_ledger_budget'),

  setLedgerBudget: (monthlyBudgetCents: number) =>
    invoke<LedgerSettings>('set_ledger_budget', { monthlyBudgetCents }),
}
