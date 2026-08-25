/** 记账域：月窗口流水 + 月度总预算 + 聚合计算（本月/趋势/分类占比）。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { ledgerService } from '@/services/ledgerService'
import { addMonths, endOfMonth, monthKey, startOfMonth, todayStr } from '@/utils/date'
import type { LedgerEntry, LedgerEntryInput, LedgerSettings } from '@/types'

export interface MonthTrend {
  key: string
  label: string
  expenseCents: number
  incomeCents: number
}

export const useLedgerStore = defineStore('ledger', () => {
  /** 当前查看月份 YYYY-MM */
  const month = ref(monthKey(todayStr()))
  /** 近 6 个月窗口流水（含当前月），按日期倒序 */
  const entries = ref<LedgerEntry[]>([])
  const settings = ref<LedgerSettings | null>(null)
  const loading = ref(false)
  /** 已加载的窗口范围，避免重复请求 */
  let loadedWindow: [string, string] | null = null

  const winStart = computed(() => startOfMonth(addMonths(`${month.value}-01`, -5)))
  const winEnd = computed(() => endOfMonth(`${month.value}-01`))

  async function loadMonth(m?: string): Promise<void> {
    if (m) month.value = m
    const start = winStart.value
    const end = winEnd.value
    if (loadedWindow && loadedWindow[0] === start && loadedWindow[1] === end) return
    loading.value = true
    try {
      entries.value = await ledgerService.listLedgerEntries(start, end)
      loadedWindow = [start, end]
    } finally {
      loading.value = false
    }
  }

  async function loadBudget(): Promise<void> {
    settings.value = await ledgerService.getLedgerBudget()
  }

  /** 写操作后刷新窗口（保证聚合与新数据一致） */
  async function refresh(): Promise<void> {
    entries.value = await ledgerService.listLedgerEntries(winStart.value, winEnd.value)
  }

  async function create(input: LedgerEntryInput): Promise<void> {
    await ledgerService.createLedgerEntry(input)
    await refresh()
  }

  async function update(entry: LedgerEntry): Promise<void> {
    await ledgerService.updateLedgerEntry(entry)
    await refresh()
  }

  async function remove(id: number): Promise<void> {
    await ledgerService.deleteLedgerEntry(id)
    await refresh()
  }

  async function setBudget(monthlyBudgetCents: number): Promise<void> {
    settings.value = await ledgerService.setLedgerBudget(monthlyBudgetCents)
  }

  /* ---- 聚合 ---- */

  const monthEntries = computed(() =>
    entries.value.filter((e) => monthKey(e.date) === month.value),
  )

  const monthExpenseCents = computed(() =>
    monthEntries.value.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0),
  )

  const monthIncomeCents = computed(() =>
    monthEntries.value.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amountCents, 0),
  )

  /** 本月支出分类占比（按金额降序） */
  const expenseByCategory = computed(() => {
    const map = new Map<string, number>()
    for (const e of monthEntries.value) {
      if (e.kind !== 'expense') continue
      map.set(e.category, (map.get(e.category) ?? 0) + e.amountCents)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  })

  /** 近 6 个月收支趋势（含当前月） */
  const trend = computed<MonthTrend[]>(() => {
    const out: MonthTrend[] = []
    for (let i = 5; i >= 0; i--) {
      const m = monthKey(addMonths(`${month.value}-01`, -i))
      let expense = 0
      let income = 0
      for (const e of entries.value) {
        if (monthKey(e.date) !== m) continue
        if (e.kind === 'expense') expense += e.amountCents
        else income += e.amountCents
      }
      out.push({
        key: m,
        label: `${Number(m.slice(5))}月`,
        expenseCents: expense,
        incomeCents: income,
      })
    }
    return out
  })

  return {
    month,
    entries,
    settings,
    loading,
    monthEntries,
    monthExpenseCents,
    monthIncomeCents,
    expenseByCategory,
    trend,
    loadMonth,
    loadBudget,
    create,
    update,
    remove,
    setBudget,
  }
})
