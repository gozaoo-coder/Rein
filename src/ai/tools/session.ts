/** 训练课会话域工具：只读查看进行中的训练 · 写操作（start/snapshot/finish/abort）由沉浸式 UI 驱动，不开放给模型 */

import { Type } from '@earendil-works/pi-ai'

import { sessionService } from '@/services/sessionService'
import { defineTool, type AppTool } from './types'

export const sessionTools: AppTool[] = [
  defineTool({
    name: 'get_active_session',
    group: 'session',
    label: '查看进行中训练',
    description: '查看当前进行中的训练课会话（课程名、已进行秒数、进度到第几个动作第几组）。没有进行中训练返回 null。',
    parameters: Type.Object({}),
    async execute() {
      const s = await sessionService.getActive()
      if (!s) return null
      return {
        id: s.id,
        planName: s.planName,
        startedAt: s.startedAt,
        elapsedSec: s.elapsedSec,
        progress: `动作 ${s.exIndex + 1} · 第 ${s.setIndex + 1} 组`,
        phase: s.state?.phase ?? null,
      }
    },
  }),
]
