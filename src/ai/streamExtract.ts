/**
 * 流式 JSON 协议的增量提取。
 *
 * 各 AI 面板约定模型「只输出一个 JSON 对象」，但前端希望在文本尚未流完时
 * 就把已确定的部分展示出来（聊天气泡流正文、复盘流诊断、智能添加流草稿）。
 * 这里提供无状态原语：输入任意前缀（不完整 JSON），返回已能确定的内容——
 *
 * - jsonStringField：顶层字符串字段的部分值（转义按 JSON 规则增量解码）
 * - jsonArrayItems：顶层数组字段中已完整的元素（逐个 JSON.parse）
 * - chatStreamView：聊天输出协议（kind: chat|food）的展示视图
 *
 * 键定位用小型扫描器（逐键跳值），值内容里出现 `"text":` 之类字样不会误命中。
 */

const NOT_JSON = -1 /** 前缀已能断定不是 JSON（当纯文本处理） */
const WAITING = -2 /** 空白或代码围栏未流完，还不能断定 */

function jsonStartIndex(raw: string): number {
  let i = 0
  while (i < raw.length && /\s/.test(raw[i]!)) i++
  if (i >= raw.length) return WAITING
  // 容忍模型不守约输出的 ```json 围栏
  if (raw.startsWith('```', i)) {
    const nl = raw.indexOf('\n', i)
    if (nl === -1) return WAITING
    i = nl + 1
    while (i < raw.length && /\s/.test(raw[i]!)) i++
    if (i >= raw.length) return WAITING
  }
  return raw[i] === '{' ? i : NOT_JSON
}

/** 跳过一个完整 JSON 字符串，返回收尾引号之后的下标；未流完返回 -1 */
function skipString(raw: string, start: number): number {
  let i = start + 1
  while (i < raw.length) {
    const c = raw[i]!
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else i++
  }
  return -1
}

/** 跳过一个完整 JSON 值（任意类型），返回结束后的下标；未流完返回 -1 */
function skipValue(raw: string, start: number): number {
  const c = raw[start]
  if (c === '"') return skipString(raw, start)
  if (c === '{' || c === '[') {
    const open = c
    const close = c === '{' ? '}' : ']'
    let depth = 0
    let i = start
    while (i < raw.length) {
      const ch = raw[i]!
      if (ch === '"') {
        i = skipString(raw, i)
        if (i === -1) return -1
        continue
      }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return -1
  }
  // 标量：读到分隔符为止；先到输入末尾说明还没流完
  let i = start
  while (i < raw.length && !',]} \t\r\n'.includes(raw[i]!)) i++
  return i < raw.length ? i : -1
}

/** 读取一个完整 JSON 字符串并解码转义；未流完返回 null */
function readString(raw: string, start: number): { value: string; end: number } | null {
  let out = ''
  let i = start + 1
  while (i < raw.length) {
    const c = raw[i]!
    if (c === '"') return { value: out, end: i + 1 }
    if (c === '\\') {
      const e = raw[i + 1]
      if (e === undefined) return null
      i += 2
      switch (e) {
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'u': {
          const hex = raw.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
          break
        }
        default: return null
      }
      continue
    }
    out += c
    i++
  }
  return null
}

/** 读取一个（可能未流完的）JSON 字符串的部分值；截断处为止，已解码 */
function partialString(raw: string, quoteStart: number): string {
  const full = readString(raw, quoteStart)
  if (full) return full.value
  // 截断：逐字符走一遍，解码到能确定的部分
  let out = ''
  let i = quoteStart + 1
  while (i < raw.length) {
    const c = raw[i]!
    if (c === '"') break
    if (c === '\\') {
      const e = raw[i + 1]
      if (e === undefined) break
      i += 2
      switch (e) {
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'u': {
          const hex = raw.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) i = raw.length
          else {
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
          }
          break
        }
        default: out += e
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 逐键扫描顶层对象；visit 返回 'stop' 中止。值未流完即停止（更深的键还没出现） */
function scanTopLevel(
  raw: string,
  objStart: number,
  visit: (key: string, valueStart: number) => 'stop' | 'skip',
): void {
  let i = objStart + 1
  for (;;) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++
    if (i >= raw.length) return
    const c = raw[i]!
    if (c === '}') return
    if (c === ',') {
      i++
      continue
    }
    if (c !== '"') return
    const key = readString(raw, i)
    if (!key) return
    i = key.end
    while (i < raw.length && /\s/.test(raw[i]!)) i++
    if (raw[i] !== ':') return
    i++
    while (i < raw.length && /\s/.test(raw[i]!)) i++
    if (visit(key.value, i) === 'stop') return
    const end = skipValue(raw, i)
    if (end === -1) return
    i = end
  }
}

/** 顶层字符串字段的（部分）值；字段未出现或还没流到返回 null */
export function jsonStringField(raw: string, field: string): string | null {
  const s = jsonStartIndex(raw)
  if (s < 0) return null
  let result: string | null = null
  scanTopLevel(raw, s, (key, vs) => {
    if (key !== field) return 'skip'
    if (raw[vs] === '"') result = partialString(raw, vs)
    return 'stop'
  })
  return result
}

/** 顶层数组字段中已完整流出的元素（最后一个元素流到一半不计入） */
export function jsonArrayItems(raw: string, field: string): unknown[] {
  const s = jsonStartIndex(raw)
  if (s < 0) return []
  const out: unknown[] = []
  scanTopLevel(raw, s, (key, vs) => {
    if (key !== field || raw[vs] !== '[') return 'skip'
    let i = vs + 1
    for (;;) {
      while (i < raw.length && /\s/.test(raw[i]!)) i++
      if (i >= raw.length) return 'stop'
      const c = raw[i]!
      if (c === ']') return 'stop'
      if (c === ',') {
        i++
        continue
      }
      const end = skipValue(raw, i)
      if (end === -1) return 'stop'
      try {
        out.push(JSON.parse(raw.slice(i, end)))
      } catch {
        return 'stop'
      }
      i = end
    }
  })
  return out
}

/* ---------------- 聊天输出协议的展示视图 ---------------- */

export type ChatStreamMode = 'undecided' | 'chat' | 'food' | 'plain'

export interface ChatStreamView {
  mode: ChatStreamMode
  /** 用户可见文本：chat/plain 为已流出的正文，food/undecided 为空串 */
  text: string
}

/** 聊天最终输出是 {"kind":"chat","text":..} 或 {"kind":"food",..}，
 * 流式过程中把已流出的正文解出来直接展示，food 卡则等定稿再 morph。 */
export function chatStreamView(raw: string): ChatStreamView {
  const s = jsonStartIndex(raw)
  if (s === NOT_JSON) return { mode: 'plain', text: raw }
  if (s === WAITING) return { mode: 'undecided', text: '' }
  let kind: string | null = null
  scanTopLevel(raw, s, (key, vs) => {
    if (key !== 'kind') return 'skip'
    kind = raw[vs] === '"' ? (readString(raw, vs)?.value ?? null) : null
    return 'stop'
  })
  if (kind === 'chat') {
    return { mode: 'chat', text: jsonStringField(raw, 'text') ?? '' }
  }
  if (kind === 'food') return { mode: 'food', text: '' }
  return { mode: 'undecided', text: '' }
}
