/** 记账域工具：流水 CRUD + 月度预算 · 对应 ledgerService（存储为整数分，工具层用元） */

import { Type } from '@earendil-works/pi-ai'

import { categoriesOf, LEDGER_CATEGORIES } from '@/config/ledger'
import { ledgerService } from '@/services/ledgerService'
import type { LedgerEntry, LedgerKind } from '@/types'
import { endOfMonth, startOfMonth, todayStr } from '@/utils/date'
import { centsToYuan, defineTool, resolveDate, yuanToCents, type AppTool } from './types'

/** 分类字面量联合（key 随配置走，中文标签写进描述） */
const CATEGORY_KEYS = LEDGER_CATEGORIES.map((c) => c.key)
const CATEGORY_DESC = `分类 key：${LEDGER_CATEGORIES.map((c) => `${c.key}=${c.label}`).join(' / ')}`
const CATEGORY = Type.Union(
  CATEGORY_KEYS.map((k) => Type.Literal(k)),
  { description: CATEGORY_DESC },
)

function assertCategory(kind: LedgerKind, category: string): void {
  if (!categoriesOf(kind).some((c) => c.key === category)) {
    const valid = categoriesOf(kind)
      .map((c) => c.key)
      .join('/')
    throw new Error(`「${category}」不是${kind === 'expense' ? '支出' : '收入'}的合法分类，可选：${valid}`)
  }
}

function brief(e: LedgerEntry) {
  return {
    id: e.id,
    kind: e.kind,
    category: e.category,
    amountYuan: centsToYuan(e.amountCents),
    note: e.note,
    date: e.date,
  }
}

export const ledgerTools: AppTool[] = [
  defineTool({
    name: 'list_entries',
    group: 'ledger',
    label: '查看账目',
    description: '查看某日期区间的收支流水，可按分类过滤、按备注关键词搜索。区间不传默认本月。',
    parameters: Type.Object({
      start: Type.Optional(Type.String({ description: '起始 YYYY-MM-DD，缺省为本月 1 日' })),
      end: Type.Optional(Type.String({ description: '结束 YYYY-MM-DD，缺省为本月末' })),
      category: Type.Optional(Type.String({ description: '按分类 key 过滤' })),
      keyword: Type.Optional(Type.String({ description: '按备注关键词模糊搜索' })),
    }),
    async execute(args) {
      const today = todayStr()
      const rows = await ledgerService.listLedgerEntries(
        args.start?.trim() ? resolveDate(args.start, 'start') : startOfMonth(today),
        args.end?.trim() ? resolveDate(args.end, 'end') : endOfMonth(today),
        args.category ?? null,
        args.keyword ?? null,
      )
      let expense = 0
      let income = 0
      const entries = rows.map((e) => {
        if (e.kind === 'expense') expense += e.amountCents
        else income += e.amountCents
        return brief(e)
      })
      return {
        count: entries.length,
        expenseYuan: centsToYuan(expense),
        incomeYuan: centsToYuan(income),
        entries,
      }
    },
  }),

  defineTool({
    name: 'create_entry',
    group: 'ledger',
    label: '记一笔账',
    description: '新增一条收入或支出。amountYuan 为正数金额（元）；date 不传默认今天。',
    parameters: Type.Object({
      kind: Type.Union([Type.Literal('expense'), Type.Literal('income')], {
        description: 'expense=支出 / income=收入',
      }),
      category: CATEGORY,
      amountYuan: Type.Number({ description: '金额（元，正数），如 25.5' }),
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，缺省为今天' })),
      note: Type.Optional(Type.String({ description: '备注' })),
    }),
    async execute(args) {
      assertCategory(args.kind as LedgerKind, args.category)
      if (!(args.amountYuan > 0)) throw new Error(`金额必须为正数：${args.amountYuan}`)
      const row = await ledgerService.createLedgerEntry({
        kind: args.kind as LedgerKind,
        category: args.category,
        amountCents: yuanToCents(args.amountYuan),
        note: args.note ?? null,
        date: resolveDate(args.date),
      })
      return { ok: true, id: row.id, entry: brief(row) }
    },
  }),

  defineTool({
    name: 'update_entry',
    group: 'ledger',
    label: '修改账目',
    description: '修改一条流水，只传需要改的字段；id 来自 list_entries。',
    parameters: Type.Object({
      id: Type.Number({ description: '流水 id' }),
      kind: Type.Optional(
        Type.Union([Type.Literal('expense'), Type.Literal('income')], {
          description: 'expense=支出 / income=收入',
        }),
      ),
      category: Type.Optional(CATEGORY),
      amountYuan: Type.Optional(Type.Number({ description: '新金额（元，正数）' })),
      date: Type.Optional(Type.String({ description: '改到 YYYY-MM-DD' })),
      note: Type.Optional(Type.String({ description: '新备注' })),
    }),
    async execute(args) {
      const all = await ledgerService.listLedgerEntries('2000-01-01', '2999-12-31', null, null)
      const cur = all.find((e) => e.id === args.id)
      if (!cur) throw new Error(`流水不存在：id=${args.id}（先用 list_entries 查 id）`)
      const kind = (args.kind as LedgerKind | undefined) ?? cur.kind
      const category = args.category ?? cur.category
      assertCategory(kind, category)
      if (args.amountYuan != null && !(args.amountYuan > 0)) throw new Error(`金额必须为正数：${args.amountYuan}`)
      const saved = await ledgerService.updateLedgerEntry({
        ...cur,
        kind,
        category,
        amountCents: args.amountYuan != null ? yuanToCents(args.amountYuan) : cur.amountCents,
        note: args.note ?? cur.note,
        date: args.date?.trim() ? resolveDate(args.date) : cur.date,
      })
      return { ok: true, entry: brief(saved) }
    },
  }),

  defineTool({
    name: 'delete_entry',
    group: 'ledger',
    label: '删除账目',
    description: '删除一条流水。仅限用户明确要求删除时使用。',
    dangerous: true,
    parameters: Type.Object({ id: Type.Number({ description: '流水 id' }) }),
    async execute(args) {
      await ledgerService.deleteLedgerEntry(args.id)
      return { ok: true }
    },
  }),

  defineTool({
    name: 'get_budget',
    group: 'ledger',
    label: '查看月度预算',
    description: '查看月度总预算（元）。未设置返回 0。',
    parameters: Type.Object({}),
    async execute() {
      const s = await ledgerService.getLedgerBudget()
      return { monthlyBudgetYuan: centsToYuan(s.monthlyBudgetCents), updatedAt: s.updatedAt }
    },
  }),

  defineTool({
    name: 'set_budget',
    group: 'ledger',
    label: '设置月度预算',
    description: '设置月度总预算（元）；传 0 表示清除预算。',
    parameters: Type.Object({
      monthlyBudgetYuan: Type.Number({ description: '月度预算（元），≥0' }),
    }),
    async execute(args) {
      if (args.monthlyBudgetYuan < 0) throw new Error(`预算不能为负：${args.monthlyBudgetYuan}`)
      await ledgerService.setLedgerBudget(yuanToCents(args.monthlyBudgetYuan))
      return { ok: true, monthlyBudgetYuan: args.monthlyBudgetYuan }
    },
  }),
]
