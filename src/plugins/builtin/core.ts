import { Camera, ListTodo, Mic, PiggyBank, Sparkles, Timer, Utensils, Wallet } from 'lucide-vue-next'

import { definePlugin } from '../registry'
import { fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'

/**
 * 内核插件：功能固定开启（不进「打开或关闭功能」），但同样走插件层声明自己的
 * 导航条目与工具卡——这样导航栏、主页工具格只有一条数据来源，没有第二份硬编码清单。
 */

export const nutritionPlugin = definePlugin({
  id: 'nutrition',
  name: '营养',
  desc: '记饮食、食物库与营养全览',
  icon: Utensils,
  accent: '--c-intake',
  routes: ['nutrition', 'nutrition-adjust', 'nutrition-foods', 'nutrition-recipes'],
  nav: [{ route: 'nutrition', label: '营养', icon: Utensils, surfaces: ['rail'], order: 110 }],
  tools: [
    {
      id: 'nutrition.smart-add',
      title: '记饮食',
      sub: '拍照 / 文字 · AI 帮你记',
      icon: Camera,
      ic: {
        background: 'color-mix(in srgb, var(--c-intake) 12%, transparent)',
        color: 'var(--c-intake)',
      },
      order: 10,
      action: 'smart-add',
    },
  ],
})

export const voicePlugin = definePlugin({
  id: 'voice',
  name: '语音',
  desc: '实时转写与 AI 纪要',
  icon: Mic,
  accent: '--led-shopping',
  tools: [
    {
      id: 'voice.session',
      title: '语音对话',
      sub: '实时转写 · AI 纪要',
      icon: Mic,
      ic: {
        background: 'color-mix(in srgb, var(--led-shopping) 12%, transparent)',
        color: 'var(--led-shopping)',
      },
      order: 40,
      action: 'voice-session',
    },
  ],
})

export const aiPlugin = definePlugin({
  id: 'ai',
  name: 'AI',
  desc: '对话、拍照识别与知识库',
  icon: Sparkles,
  accent: '--cat-study',
  routes: ['ai', 'ai-models', 'ai-knowledge', 'ai-knowledge-files', 'ai-files'],
  nav: [{ route: 'ai', label: 'AI', icon: Sparkles, surfaces: ['tabbar', 'rail'], order: 170 }],
  tools: [
    {
      id: 'ai.chat',
      title: 'AI 助手',
      sub: '提问 · 拍照识别',
      icon: Sparkles,
      ic: {
        background: 'color-mix(in srgb, var(--cat-study) 14%, transparent)',
        color: 'var(--cat-study)',
      },
      order: 50,
      to: { name: 'ai' },
    },
  ],
})

export const focusPlugin = definePlugin({
  id: 'focus',
  name: '专注',
  desc: '番茄钟与专注记录',
  icon: Timer,
  accent: '--cat-work',
  routes: ['focus'],
  nav: [{ route: 'focus', label: '专注', icon: Timer, surfaces: ['rail'], order: 140 }],
  tools: [
    {
      id: 'focus.open',
      title: '专注',
      sub: '番茄钟 · 待办 · 日程',
      icon: Timer,
      ic: {
        background: 'color-mix(in srgb, var(--cat-work) 12%, transparent)',
        color: 'var(--cat-work)',
      },
      order: 60,
      to: { name: 'focus' },
    },
  ],
})

export const todoPlugin = definePlugin({
  id: 'todos',
  name: '待办',
  desc: '今日画布、周时间线与清单',
  icon: ListTodo,
  accent: '--cat-general',
  routes: ['todos'],
  nav: [{ route: 'todos', label: '待办', icon: ListTodo, surfaces: ['rail'], order: 150 }],
})

export const ledgerPlugin = definePlugin({
  id: 'ledger',
  name: '记账',
  desc: '流水、预算与月度结余',
  icon: Wallet,
  accent: '--ok-strong',
  routes: ['ledger'],
  nav: [{ route: 'ledger', label: '记账', icon: PiggyBank, surfaces: ['rail'], order: 160 }],
  tools: [
    {
      id: 'ledger.open',
      title: '记账',
      sub: () => `本月支出 ¥${fmtCents(useLedgerStore().monthExpenseCents)}`,
      icon: Wallet,
      ic: {
        background: 'color-mix(in srgb, var(--cat-workout) 12%, transparent)',
        color: 'var(--ok-strong)',
      },
      order: 70,
      to: { name: 'ledger' },
    },
  ],
})
