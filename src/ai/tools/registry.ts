/**
 * 统一工具注册表：聚合各域 AppTool，并适配成 pi-agent-core 的 AgentTool。
 *
 * 新增一个模型可调用能力的完整路径：
 * 1. 在本目录对应域文件里 defineTool（入参用模型友好形状，execute 内换算）；
 * 2. 在下方 APP_TOOLS 里登记；
 * 3. 需要在系统提示词的分组清单里补一句说明（src/ai/chat.ts）。
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'

import { contextTools } from './misc'
import { dietTools } from './diet'
import { exerciseTools } from './exercise'
import { imageTools } from './image'
import { knowledgeTools } from './knowledge'
import { ledgerTools } from './ledger'
import { memoryTools } from './memory'
import { modelTools } from './models'
import { noteTools } from './notes'
import { nutritionTools } from './nutrition'
import { planTools } from './plan'
import { pomodoroTools } from './pomodoro'
import { programTools } from './program'
import { sessionTools } from './session'
import type { AppTool } from './types'
import { todoTools } from './todo'
import { voiceTools } from './voice'
import { webTools } from './web'
import { workspaceTools } from './workspace'

/** 全部应用数据工具（不含聊天自身的 JSON 输出协议） */
export const APP_TOOLS: AppTool[] = [
  ...dietTools,
  ...nutritionTools,
  ...todoTools,
  ...ledgerTools,
  ...exerciseTools,
  ...planTools,
  ...programTools,
  ...pomodoroTools,
  ...sessionTools,
  ...contextTools,
  ...knowledgeTools,
  ...memoryTools,
  ...noteTools,
  ...workspaceTools,
  ...modelTools,
  ...voiceTools,
  ...webTools,
  ...imageTools,
]

const BY_NAME = new Map(APP_TOOLS.map((t) => [t.name, t]))

/** 按工具名查定义（UI 过程卡取 label / dangerous 用） */
export function findAppTool(name: string): AppTool | undefined {
  return BY_NAME.get(name)
}

/** AppTool → AgentTool：默认结果包成 {ok:true,data} 文本；rawContent 工具原样透传内容块（可含图片）；失败 throw 由框架回灌错误 */
function toAgentTool(t: AppTool): AgentTool {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    execute: async (_toolCallId, params) => {
      const data = await t.execute(params as never)
      if (t.rawContent) return data as AgentToolResult<unknown>
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
        details: data,
      }
    },
  }
}

/** 注册表 → Agent 工具集；传 onlyNames 时只挂指定工具（如视觉识别轮只给 search_food） */
export function buildAppAgentTools(onlyNames?: string[]): AgentTool[] {
  const tools = onlyNames ? APP_TOOLS.filter((t) => onlyNames.includes(t.name)) : APP_TOOLS
  return tools.map(toAgentTool)
}
