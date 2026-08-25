/** 待办域：按日列表 + 周/月统计（周视图、月视图的数据源）。 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { todoService } from '@/services/todoService'
import { todayStr } from '@/utils/date'
import type { Todo, TodoInput } from '@/types'

export interface DayStat {
  total: number
  done: number
}

export const useTodoStore = defineStore('todo', () => {
  /** 当天（或当前选中日期）的待办 */
  const dayTodos = ref<Todo[]>([])
  /** 全部待办（含收件箱）：主页紧急列表、全部待办页与虚拟时间线的数据源 */
  const allTodos = ref<Todo[]>([])
  /** 周视图 / 月视图共用的完成度缓存，key 为 YYYY-MM-DD */
  const statsByDate = ref<Record<string, DayStat>>({})

  async function loadDay(date: string): Promise<void> {
    dayTodos.value = await todoService.listTodos(date, date)
  }

  /** 拉取全部待办（过期手动清理无需调用，写操作会自动刷新） */
  async function loadAll(): Promise<void> {
    allTodos.value = await todoService.listAllTodos()
  }

  /** 拉取区间并合并进统计缓存；返回该区间的映射 */
  async function loadStats(startDate: string, endDate: string): Promise<Record<string, DayStat>> {
    const todos = await todoService.listTodos(startDate, endDate)
    const range: Record<string, DayStat> = {}
    for (const t of todos) {
      if (!t.date) continue
      ;(range[t.date] ??= { total: 0, done: 0 }).total++
      if (t.status === 'done') range[t.date]!.done++
    }
    statsByDate.value = { ...statsByDate.value, ...range }
    return range
  }

  async function create(input: TodoInput, reloadDate = true): Promise<Todo> {
    const todo = await todoService.createTodo(input)
    if (reloadDate && input.date) await refreshDate(input.date)
    await loadAll()
    return todo
  }

  async function update(todo: Todo): Promise<void> {
    await todoService.updateTodo(todo)
    if (todo.date) await refreshDate(todo.date)
    await loadAll()
  }

  async function toggle(todo: Todo): Promise<void> {
    const next: Todo = {
      ...todo,
      status: todo.status === 'done' ? 'todo' : 'done',
      completedAt: todo.status === 'done' ? null : new Date().toISOString(),
    }
    await update(next)
  }

  async function remove(todo: Todo): Promise<void> {
    await todoService.deleteTodo(todo.id)
    if (todo.date) await refreshDate(todo.date)
    await loadAll()
  }

  /** 写操作后同步刷新日列表与统计 */
  async function refreshDate(date: string): Promise<void> {
    await Promise.all([loadDay(date), loadStats(...startOfMonthRange(date))])
  }

  function startOfMonthRange(date: string): [string, string] {
    // 简化：刷新前后各扩 45 天，覆盖月视图范围
    const d = new Date(date)
    const start = new Date(d.getFullYear(), d.getMonth() - 1, 1)
    const end = new Date(d.getFullYear(), d.getMonth() + 2, 0)
    const fmt = (x: Date) =>
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
    return [fmt(start), fmt(end)]
  }

  return {
    dayTodos,
    allTodos,
    statsByDate,
    today: todayStr(),
    loadDay,
    loadAll,
    loadStats,
    create,
    update,
    toggle,
    remove,
  }
})
