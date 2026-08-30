/** 待办域工具：日视图 / 全量列表 / 增删改 · 对应 todoService */

import { Type } from '@earendil-works/pi-ai'

import { todoService } from '@/services/todoService'
import type { Todo, TodoCategory, TodoStatus } from '@/types'
import { describeRule } from '@/utils/recurrence'
import { defineTool, hhmmToMin, optDate, resolveDate, type AppTool } from './types'

const CATEGORY = Type.Union(
  [
    Type.Literal('general'),
    Type.Literal('workout'),
    Type.Literal('health'),
    Type.Literal('study'),
    Type.Literal('work'),
  ],
  { description: '分类：general=日常 / workout=运动 / health=健康 / study=学习 / work=工作' },
)
const PRIORITY = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], {
  description: '重要程度：0=普通 / 1=重要 / 2=紧急',
})
const STATUS = Type.Union([Type.Literal('todo'), Type.Literal('doing'), Type.Literal('done')], {
  description: '状态：todo=待办 / doing=进行中 / done=已完成',
})

/** 列表投影：只留模型需要的字段 */
function brief(t: Todo) {
  return {
    id: t.id,
    title: t.title,
    date: t.date,
    startMin: t.startMin,
    durationMin: t.durationMin,
    category: t.category,
    priority: t.priority,
    status: t.status,
    /** 子任务进度（如有） */
    subtasks: t.subtasks?.length
      ? `${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length} 完成`
      : undefined,
    /** 重复规则摘要（模板行才有） */
    repeat: t.recRule ? describeRule(t.recRule) : undefined,
  }
}

export const todoTools: AppTool[] = [
  defineTool({
    name: 'list_todos',
    group: 'todo',
    label: '查看待办（按日期）',
    description: '查看某日期区间内的排期待办。start/end 不传默认今天；查收件箱用 list_all_todos。',
    parameters: Type.Object({
      start: Type.Optional(Type.String({ description: '起始 YYYY-MM-DD，缺省为今天' })),
      end: Type.Optional(Type.String({ description: '结束 YYYY-MM-DD，缺省为同 start' })),
    }),
    async execute(args) {
      const start = resolveDate(args.start, 'start')
      return todoService.listTodos(start, args.end ? resolveDate(args.end, 'end') : start)
    },
  }),

  defineTool({
    name: 'list_all_todos',
    group: 'todo',
    label: '查看全部待办',
    description: '查看全部待办（含无日期的收件箱），按日期→时间→优先级排序。改某条待办前先在这里找 id。',
    parameters: Type.Object({}),
    async execute() {
      const rows = await todoService.listAllTodos()
      return rows.map(brief)
    },
  }),

  defineTool({
    name: 'create_todo',
    group: 'todo',
    label: '新建待办',
    description:
      '创建一条待办。date 不传进收件箱；要排在某天就传 YYYY-MM-DD，可另给 startTime（HH:mm）与 durationMin。',
    parameters: Type.Object({
      title: Type.String({ description: '标题' }),
      notes: Type.Optional(Type.String({ description: '备注' })),
      date: Type.Optional(Type.String({ description: 'YYYY-MM-DD；缺省 = 不安排日期（收件箱）' })),
      startTime: Type.Optional(Type.String({ description: '开始时间 HH:mm（需与 date 同传才有意义）' })),
      durationMin: Type.Optional(Type.Number({ description: '预计时长（分钟）' })),
      category: Type.Optional(CATEGORY),
      priority: Type.Optional(PRIORITY),
      repeat: Type.Optional(
        Type.Object(
          {
            freq: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('interval')]),
            weekdays: Type.Optional(Type.Array(Type.Number(), { description: 'weekly 专用：周一=0…周日=6' })),
            intervalDays: Type.Optional(Type.Number({ description: 'interval 专用：每 N 天' })),
            endDate: Type.Optional(Type.String({ description: '结束日期 YYYY-MM-DD，缺省永不' })),
          },
          { description: '重复规则；用户说"每天/每周X/每N天"时才传' },
        ),
      ),
    }),
    async execute(args) {
      const recRule = args.repeat
        ? {
            freq: args.repeat.freq,
            weekdays: args.repeat.weekdays ?? [],
            intervalDays: args.repeat.intervalDays ?? 0,
            endDate: args.repeat.endDate ?? null,
          }
        : null
      const todo = await todoService.createTodo({
        title: args.title.trim(),
        notes: args.notes ?? null,
        date: optDate(args.date),
        startMin: args.startTime ? hhmmToMin(args.startTime) : null,
        durationMin: args.durationMin ?? null,
        category: (args.category as TodoCategory | undefined) ?? 'general',
        priority: args.priority ?? 0,
        recRule,
      })
      return { ok: true, id: todo.id, todo: brief(todo) }
    },
  }),

  defineTool({
    name: 'update_todo',
    group: 'todo',
    label: '修改待办',
    description: '修改一条待办，只传需要改的字段；id 来自 list_all_todos / list_todos。标记完成传 status:"done"。',
    parameters: Type.Object({
      id: Type.Number({ description: '待办 id' }),
      title: Type.Optional(Type.String({ description: '新标题' })),
      notes: Type.Optional(Type.String({ description: '新备注' })),
      date: Type.Optional(Type.String({ description: '改期到 YYYY-MM-DD' })),
      startTime: Type.Optional(Type.String({ description: '开始时间 HH:mm' })),
      durationMin: Type.Optional(Type.Number({ description: '时长（分钟）' })),
      category: Type.Optional(CATEGORY),
      priority: Type.Optional(PRIORITY),
      status: Type.Optional(STATUS),
    }),
    async execute(args) {
      const all = await todoService.listAllTodos()
      const cur = all.find((t) => t.id === args.id)
      if (!cur) throw new Error(`待办不存在：id=${args.id}（先用 list_all_todos 查 id）`)
      const next: Todo = {
        ...cur,
        title: args.title?.trim() || cur.title,
        notes: args.notes ?? cur.notes,
        date: args.date?.trim() ? resolveDate(args.date) : cur.date,
        startMin: args.startTime ? hhmmToMin(args.startTime) : cur.startMin,
        durationMin: args.durationMin ?? cur.durationMin,
        category: (args.category as TodoCategory | undefined) ?? cur.category,
        priority: args.priority ?? cur.priority,
        status: (args.status as TodoStatus | undefined) ?? cur.status,
      }
      const saved = await todoService.updateTodo(next)
      return { ok: true, todo: brief(saved) }
    },
  }),

  defineTool({
    name: 'delete_todo',
    group: 'todo',
    label: '删除待办',
    description: '删除一条待办。仅限用户明确要求删除时使用。',
    dangerous: true,
    parameters: Type.Object({ id: Type.Number({ description: '待办 id' }) }),
    async execute(args) {
      await todoService.deleteTodo(args.id)
      return { ok: true }
    },
  }),
]
