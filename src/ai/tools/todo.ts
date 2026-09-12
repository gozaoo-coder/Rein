/** 待办域工具：分页列表 / 日程分布 / 增删改 · 对应 todoService */

import { Type } from '@earendil-works/pi-ai'

import { todoService } from '@/services/todoService'
import type { Todo, TodoCategory, TodoStatus } from '@/types'
import { todayStr } from '@/utils/date'
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
    label: '查看待办（分页）',
    description:
      '分页查看待办。不传日期 = 聚焦视图：逾期未完成 + 未来7天 + 收件箱（收件箱排最后）；传 start/end（YYYY-MM-DD）查指定日期区间。返回 {items, page, total, hasMore}，hasMore 为 true 时用 page 翻页；limit 默认/最大 20。改某条待办前先在这里找 id。',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: '每页条数，默认 20，最大 20' })),
      page: Type.Optional(Type.Number({ description: '页码，从 1 起，默认 1' })),
      start: Type.Optional(
        Type.String({ description: '区间起 YYYY-MM-DD（与 end 任一传入即按区间查询）' }),
      ),
      end: Type.Optional(Type.String({ description: '区间止 YYYY-MM-DD，缺省同 start' })),
    }),
    async execute(args) {
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 20)
      const page = Math.max(Math.trunc(args.page ?? 1), 1)
      const offset = (page - 1) * limit
      const today = todayStr()
      const startRaw = args.start ?? args.end
      const res = startRaw
        ? await todoService.queryTodoPage({
            today,
            scope: 'range',
            start: resolveDate(startRaw, 'start'),
            end: resolveDate(args.end ?? startRaw, 'end'),
            limit,
            offset,
          })
        : await todoService.queryTodoPage({ today, scope: 'focus', limit, offset })
      return {
        items: res.items.map(brief),
        page,
        total: res.total,
        hasMore: offset + res.items.length < res.total,
      }
    },
  }),

  defineTool({
    name: 'todo_distribution',
    group: 'todo',
    label: '日程分布总览',
    description:
      '查看全部日程的按日分布计数（年→月→日 层级，只给数量不给明细），附收件箱与逾期条数。想知道哪几天安排得多、该从哪天下钻时先调它，再用 list_todos 传 start/end 查明细，不要试图一次拉全量。',
    parameters: Type.Object({}),
    async execute() {
      const { days, inbox, overdue } = await todoService.todoDistribution(todayStr())
      /** 年 → 月 → 日 计数；键归一为非补零数字串，模型与 JSON 键序都按数值升序 */
      const years: Record<string, Record<string, Record<string, number>>> = {}
      for (const { date, count } of days) {
        const [y, m, d] = date.split('-')
        const monthKey = String(Number(m))
        const dayKey = String(Number(d))
        ;(years[y] ??= {})[monthKey] ??= {}
        years[y][monthKey][dayKey] = count
      }
      return { years, inbox, overdue }
    },
  }),

  defineTool({
    name: 'create_todo',
    group: 'todo',
    label: '新建待办',
    description:
      '创建一条待办。date 不传进收件箱；要排在某天就传 YYYY-MM-DD，可另给 startTime（HH:mm）与 durationMin。每个单元事件独立一条待办、各有自己的 date/startTime/durationMin——多段任务拆成多条分别创建，不要塞进同一条的备注或子任务里。',
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
    description:
      '修改一条待办，只传需要改的字段；id 来自 list_todos。标记完成传 status:"done"。每次调用只动一条事件，批量调整多个事件时逐条调用。',
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
      if (!cur) throw new Error(`待办不存在：id=${args.id}（先用 list_todos 查 id）`)
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
