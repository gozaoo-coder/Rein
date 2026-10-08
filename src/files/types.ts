/**
 * 文件管理器的领域模型（与具体后端解耦）。
 *
 * 两条原则（见 docs/ai-workspace.md §5「文件管理器」）：
 * 1. **FileItem 是稳定的视图模型**：身份用 `providerId:path` 而不是列表索引，
 *    所以刷新、排序、过滤、切换视图之后，选择与焦点能按 id 恢复；元数据（大小/时间/
 *    权限/能力）一次性带全，UI 不再为一个条目去查一次后端。
 * 2. **视图状态与数据分离**：选中 / 焦点 / 剪切 / 拖拽悬停 / 就地编辑都在
 *    `ItemViewState` 这一侧（由 selection / clipboard / 组件各自持有），
 *    任何时候都不写回 FileItem —— 否则一次刷新就会把用户的选择洗掉。
 */

export type FileKind = 'folder' | 'text' | 'image' | 'audio' | 'video' | 'file'

/** 文件能力：菜单项的可用性与原因都由 provider 给，UI 不自己猜 */
export type FileAction =
  | 'open'
  | 'preview'
  | 'rename'
  | 'delete'
  | 'move'
  | 'copy'
  | 'pin'
  | 'restore'
  | 'purge'

/** `id` / `uri` 之外的展示字段都可从 KbEntry 推导，这里保持扁平、可序列化。 */
export interface FileItem {
  /** 稳定标识：`{providerId}:{path}`。不要用列表索引 —— 排序/刷新后索引会变。 */
  id: string
  /** 统一资源标识：本地是 `kb://{path}`；将来的云/网络 provider 用各自 scheme */
  uri: string
  /** 真实名称（含扩展名） */
  name: string
  /** 显示名称：已知扩展名默认隐藏（列表用扩展名列另标），国际化改这里 */
  displayName: string
  /** 排序专用：小写化后的名称（自然排序用，`file2 < file10`） */
  sortName: string
  /** 扩展名（小写、不含点）；目录与无扩展名文件为空 */
  extension?: string
  kind: FileKind
  isDir: boolean
  /** 字节数（文本按 UTF-8、多模态按本体、目录为自身占用） */
  size?: number
  /** 创建时间（毫秒时间戳）；派生投影拿不到时为 undefined */
  createdAt?: number
  /** 修改时间（毫秒时间戳） */
  modifiedAt?: number
  /** 业务日期（派生投影的 occurred_on） */
  occurredOn?: string | null
  attributes: {
    /** 点开头（或后端标记）：默认不显示，由「显示隐藏文件」开关控制 */
    hidden: boolean
    /** 只读：系统文件与派生投影 */
    readOnly: boolean
    /** 系统文件（规范/、系统提示词/），不可改不可删 */
    system: boolean
  }
  permissions: {
    canRead: boolean
    canWrite: boolean
    canDelete: boolean
    canRename: boolean
  }
  /** 目录的直接子项数（文件恒为 0） */
  childCount: number
  /** 用户钉住后 AI 不再自动移动 */
  pinned: boolean
  /** inbox | filed | manual | ''（派生投影没有归类状态） */
  classifyState: string
  /** 可用模态：text / image / audio / video / binary */
  modalities: string[]
  /** 用户评分 0..5（0 = 未评） */
  rating: number
  /** 用户标签（人给的分类，不进索引） */
  tags: string[]
  /** 有注释（正文走详情接口） */
  hasNote: boolean
  /** 只读原因的人话（派生投影 / 系统文件），给禁止操作的提示用 */
  readOnlyReason?: string
  /** 后端节点 id：docId 供阅读器打开，fileId 供改名/删除等文件操作 */
  docId?: number
  fileId?: number
  /** 来源类别（note / todo / workout…）；目录为空 */
  sourceType?: string
  /** 标题（派生投影的标题可能与文件名不同） */
  title?: string
  /**
   * 云/远端状态。本地工作区恒为 local —— 字段先摆在这里，
   * 将来接云 provider 时 UI 不用改（图标与文案已经按它分支）。
   */
  cloudState: 'local' | 'online' | 'syncing' | 'error'
  providerId: string
}

/** 视图状态：**绝不混进 FileItem**。选择/焦点/剪切/拖拽/就地编辑都住在这里。 */
export interface ItemViewState {
  selected: boolean
  focused: boolean
  cut: boolean
  dragOver: boolean
  editing: boolean
}

export const EMPTY_VIEW_STATE: ItemViewState = {
  selected: false,
  focused: false,
  cut: false,
  dragOver: false,
  editing: false,
}

/** 排序键：与列表头一一对应 */
export type SortKey = 'name' | 'modified' | 'size' | 'kind' | 'rating'
export type SortDir = 'asc' | 'desc'

/** 分组：无 / 按类型 / 按修改日期 / 按体积档 */
export type GroupKey = 'none' | 'kind' | 'day' | 'size'

/**
 * 视图模式：
 * - `list` 详细列表（列可配）、`grid` 图标网格；
 * - `gallery` 画廊：大图块，只看图片/视频（扫素材用）；
 * - `columns` 分栏：Finder 式栏链（快速穿目录）。
 */
export type ViewMode = 'list' | 'grid' | 'gallery' | 'columns'

/** 图标尺寸档（网格用小/中/大；列表恒为小图标行高） */
export type IconSize = 'sm' | 'md' | 'lg'

/** 剪贴板模式：复制 = 结束时复制一份；剪切 = 结束时把原件移过去 */
export type ClipMode = 'copy' | 'cut'

/** 同名冲突策略（粘贴 / 导入时问一次）：替换 / 跳过 / 保留两者（自动加 -v2） */
export type ConflictPolicy = 'replace' | 'skip' | 'keepBoth'

/** 目录列举结果 */
export interface DirListing {
  path: string
  items: FileItem[]
  total: number
  /** 后端因大目录上限截断 */
  truncated: boolean
}

/** 一次文件操作的类型（操作队列与撤销提示都按它分支） */
export type OpKind =
  | 'paste'
  | 'move'
  | 'trash'
  | 'restore'
  | 'purge'
  | 'rename'
  | 'mkdir'
  | 'upload'
  | 'emptyTrash'

/** 队列里的一条操作。UI 只读：进度条、取消按钮、失败明细都由它驱动。 */
export interface FileOp {
  id: number
  kind: OpKind
  label: string
  total: number
  done: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** 逐条失败原因（部分成功时也保留成功的部分） */
  failures: string[]
  /** 还有没做完的条目：可以「继续未完成」（断点续传的入口） */
  resumable?: boolean
}

/** 排序 / 分组 / 视图的持久化偏好（按用户记一次就够，不必每次进页面重设） */
export interface ExplorerPrefs {
  sortKey: SortKey
  sortDir: SortDir
  groupKey: GroupKey
  viewMode: ViewMode
  iconSize: IconSize
  showHidden: boolean
  /** 是否隐藏已知扩展名 */
  hideExtension: boolean
  foldersFirst: boolean
  /** 宽屏显示的列（列 key 数组；缺省 = 列注册表里的默认可见列） */
  columns?: string[]
  /** 左侧目录树（默认关：树是导航辅助，不该默认挤占版面） */
  showTree?: boolean
}
