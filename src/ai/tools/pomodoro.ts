/** 番茄钟域工具：专注记录写入与查询 · 对应 pomodoroService */

import { Type } from '@earendil-works/pi-ai'

import { pomodoroService } from '@/services/pomodoroService'
import { addDays, todayStr } from '@/utils/date'
import { defineTool, resolveDate, type AppTool } from './types'

export const pomodoroTools: AppTool[] = [
  defineTool({
    name: 'save_pomodoro',
    group: 'pomodoro',
    label: '补记番茄钟',
    description: '补记一段专注（默认按 focusMin 倒推结束时间为现在）。通常只在用户说明离线完成了一段专注时使用。',
    parameters: Type.Object({
      focusMin: Type.Number({ description: '专注时长（分钟）' }),
      breakMin: Type.Optional(Type.Number({ description: '休息时长（分钟），默认 5' })),
      todoId: Type.Optional(Type.Number({ description: '关联的待办 id' })),
      completed: Type.Optional(Type.Boolean({ description: '是否完整完成，默认 true' })),
    }),
    async execute(args) {
      const endedAt = new Date()
      const startedAt = new Date(endedAt.getTime() - args.focusMin * 60_000)
      const row = await pomodoroService.saveSession({
        todoId: args.todoId ?? null,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        focusMin: args.focusMin,
        breakMin: args.breakMin ?? 5,
        completed: args.completed ?? true,
      })
      return { ok: true, id: row.id }
    },
  }),

  defineTool({
    name: 'list_pomodoros',
    group: 'pomodoro',
    label: '查看番茄钟记录',
    description: '查看某日期区间的番茄钟记录。区间不传默认最近 7 天。',
    parameters: Type.Object({
      start: Type.Optional(Type.String({ description: '起始 YYYY-MM-DD，缺省为 6 天前' })),
      end: Type.Optional(Type.String({ description: '结束 YYYY-MM-DD，缺省为今天' })),
    }),
    async execute(args) {
      const start = args.start?.trim() ? resolveDate(args.start, 'start') : addDays(todayStr(), -6)
      const rows = await pomodoroService.listSessions(start, resolveDate(args.end))
      let totalFocusMin = 0
      const sessions = rows.map((r) => {
        totalFocusMin += r.focusMin
        return {
          id: r.id,
          todoId: r.todoId,
          startedAt: r.startedAt,
          focusMin: r.focusMin,
          completed: r.completed,
        }
      })
      return { count: sessions.length, totalFocusMin, sessions }
    },
  }),
]
