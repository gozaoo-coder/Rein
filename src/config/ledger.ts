/** 记账展示元数据：分类（key/label/图标/颜色令牌）。分类 key 与数据库字段直接对应。 */

import type { Component } from 'vue'
import {
  Car,
  Ellipsis,
  Gamepad2,
  Gift,
  GraduationCap,
  HeartPulse,
  Home,
  Plane,
  Receipt,
  RotateCcw,
  ShoppingBag,
  Utensils,
  Wallet,
} from 'lucide-vue-next'

import type { LedgerKind } from '@/types'

export interface LedgerCategory {
  key: string
  label: string
  icon: Component
  colorVar: string
  /** 该分类出现在哪些支出/收入宫格里 */
  kinds: LedgerKind[]
}

export const LEDGER_CATEGORIES: LedgerCategory[] = [
  { key: 'food', label: '餐饮', icon: Utensils, colorVar: 'var(--led-food)', kinds: ['expense'] },
  { key: 'transport', label: '交通', icon: Car, colorVar: 'var(--led-transport)', kinds: ['expense'] },
  { key: 'shopping', label: '购物', icon: ShoppingBag, colorVar: 'var(--led-shopping)', kinds: ['expense'] },
  { key: 'entertainment', label: '娱乐', icon: Gamepad2, colorVar: 'var(--led-entertainment)', kinds: ['expense'] },
  { key: 'housing', label: '居住', icon: Home, colorVar: 'var(--led-housing)', kinds: ['expense'] },
  { key: 'medical', label: '医疗', icon: HeartPulse, colorVar: 'var(--led-medical)', kinds: ['expense'] },
  { key: 'education', label: '教育', icon: GraduationCap, colorVar: 'var(--led-education)', kinds: ['expense'] },
  { key: 'bills', label: '通讯缴费', icon: Receipt, colorVar: 'var(--led-bills)', kinds: ['expense'] },
  { key: 'travel', label: '旅行', icon: Plane, colorVar: 'var(--led-travel)', kinds: ['expense'] },
  { key: 'salary', label: '工资', icon: Wallet, colorVar: 'var(--led-salary)', kinds: ['income'] },
  { key: 'bonus', label: '奖金', icon: Gift, colorVar: 'var(--led-bonus)', kinds: ['income'] },
  { key: 'refund', label: '退款', icon: RotateCcw, colorVar: 'var(--led-refund)', kinds: ['income'] },
  { key: 'other', label: '其他', icon: Ellipsis, colorVar: 'var(--led-other)', kinds: ['expense', 'income'] },
]

export function categoriesOf(kind: LedgerKind): LedgerCategory[] {
  return LEDGER_CATEGORIES.filter((c) => c.kinds.includes(kind))
}

export function categoryOf(key: string): LedgerCategory | undefined {
  return LEDGER_CATEGORIES.find((c) => c.key === key)
}

/** 金额（分）→ 字符串，如 12.50 → "12.5"；2550 → "25.5"；-3000 → "-30" */
export function fmtCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const rest = abs % 100
  if (rest === 0) return `${sign}${yuan}`
  if (rest % 10 === 0) return `${sign}${yuan}.${rest / 10}`
  return `${sign}${yuan}.${String(rest).padStart(2, '0')}`
}
