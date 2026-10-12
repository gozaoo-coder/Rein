/**
 * 数据维护域类型 · 对应 Rust `modules/maintenance/commands.rs`。
 *
 * 字段名是 IPC 契约（Rust 端 serde camelCase + 契约测试守着）：
 * 改这里必须同步改 Rust 结构体与它的 `serialize_camel_case` 测试。
 */

/** 清除档位，由浅入深。语义见 DataClearSheet 的档位说明。 */
export type DataClearScope = 'cache' | 'ai' | 'business' | 'factory'

/** 确认页清单里的一行：几张表 / 几个目录归成一组一起报数 */
export interface DataClearItem {
  key: string
  label: string
  /** 组内全部表的行数和；纯磁盘组为 null */
  count: number | null
  /** 组内全部目录的字节和；纯表组为 null */
  bytes: number | null
}

export interface DataClearPreview {
  scope: DataClearScope
  items: DataClearItem[]
  totalBytes: number
  /** 这档清完是否需要重启（缓存档 false，其余 true） */
  restartsApp: boolean
}

export interface DataClearReport {
  scope: DataClearScope
  freedBytes: number
  removedTables: string[]
  removedDirs: string[]
  /** 没删掉的（文件被占用等）：不致命，但 UI 要如实说 */
  failures: string[]
}
