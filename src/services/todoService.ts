/** 待办域 IPC 封装 · 对应 modules/todo/commands.rs */

import type { Todo, TodoInput } from '@/types'
import { invoke } from './transport'

export const todoService = {
  listTodos: (startDate: string, endDate: string) =>
    invoke<Todo[]>('list_todos', { startDate, endDate }),

  /** 全部待办（含收件箱），按日期→时间→优先级排序 */
  listAllTodos: () => invoke<Todo[]>('list_all_todos', {}),

  createTodo: (input: TodoInput) => invoke<Todo>('create_todo', { ...input }),

  updateTodo: (todo: Todo) => invoke<Todo>('update_todo', { todo }),

  deleteTodo: (id: number) => invoke<void>('delete_todo', { id }),

  /** 重复实例物化（幂等）：返回本次新增实例数。loadAll 前调用。 */
  syncRecurrences: (today: string) => invoke<number>('sync_recurrences', { today }),
}
