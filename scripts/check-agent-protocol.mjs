/**
 * check-agent-protocol —— RustAgent 壳的纯逻辑断言（Node 直跑，不起浏览器）
 *
 * 覆盖 agentProtocol.ts：历史回灌的消息转换、工具结果编码、终稿构造、单步累积
 * （工具边界与重试的重置语义）。与内核的时序/副作用（事件订阅、工具回传）
 * 由 Rust 单测与浏览器 e2e 覆盖。
 *
 * 运行：node scripts/check-agent-protocol.mjs
 */
import {
  blocksFromOutcome,
  emptyUsage,
  finalMessage,
  outcomeFromToolResult,
  StepAccumulator,
  toLlmMessages,
} from '../src/ai/agentProtocol.ts'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`)

/* ---------- 历史回灌：pi Message[] → 内核 LlmMessage[] ---------- */

eq('纯文本 user 轮', toLlmMessages([{ role: 'user', content: '你好' }]), [
  { role: 'user', content: '你好' },
])

eq(
  '带图 user 轮拆成文本 + 图片块（DeepSeek 只允许 user 带图）',
  toLlmMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张' },
        { type: 'image', data: 'AAA', mimeType: 'image/jpeg' },
      ],
    },
  ]),
  [{ role: 'user', content: '看看这张', images: [{ data: 'AAA', mime: 'image/jpeg' }] }],
)

eq(
  'assistant 轮保留思考链（DeepSeek 回灌要求）',
  toLlmMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先想' },
        { type: 'text', text: '答' },
      ],
    },
  ]),
  [{ role: 'assistant', content: '答', reasoning: '先想' }],
)

eq('assistant 无思考时 reasoning 为 null', toLlmMessages([
  { role: 'assistant', content: [{ type: 'text', text: '只有正文' }] },
]), [{ role: 'assistant', content: '只有正文', reasoning: null }])

eq('tool 轮透传 toolCallId', toLlmMessages([
  { role: 'tool', content: '结果', toolCallId: 'c1' },
]), [{ role: 'tool', content: '结果', toolCallId: 'c1' }])

eq('未知角色/无内容轮被忽略', toLlmMessages([{ role: 'system', content: 'x' }, { role: 'user' }]), [])

/* ---------- 工具结果编码 ---------- */

eq(
  'pi 风格 content 块 → 文本 + 图片',
  outcomeFromToolResult({
    content: [
      { type: 'text', text: '{"ok":true}' },
      { type: 'image', data: 'IMG', mimeType: 'image/png' },
    ],
  }),
  { content: '{"ok":true}', isError: false, images: [{ data: 'IMG', mime: 'image/png' }] },
)

eq('多个文本块换行拼接', outcomeFromToolResult({ content: [
  { type: 'text', text: 'a' },
  { type: 'text', text: 'b' },
] }), { content: 'a\nb', isError: false, images: [] })

eq('裸字符串结果原样透传', outcomeFromToolResult('纯文本结果'), {
  content: '纯文本结果', isError: false,
})

eq('非数组对象结果 JSON 化', outcomeFromToolResult({ foo: 1 }), {
  content: '{"foo":1}', isError: false,
})

eq('空 content 数组回落「已完成」', outcomeFromToolResult({ content: [] }), {
  content: '已完成', isError: false, images: [],
})

eq('内核结果 → pi content 块（工具行 brief 与放大镜图片都读它）', blocksFromOutcome({
  content: '放大完成',
  isError: false,
  images: [{ data: 'IMG', mime: 'image/png' }],
}), [
  { type: 'text', text: '放大完成' },
  { type: 'image', data: 'IMG', mimeType: 'image/png' },
])

/* ---------- 终稿消息 ---------- */

const U = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 12 }
eq('终稿无思考时只有文本块', finalMessage('答', null, U, 'stop'), {
  role: 'assistant',
  content: [{ type: 'text', text: '答' }],
  usage: U,
  stopReason: 'stop',
})
eq('终稿有思考时思考块在前（入口按块类型读取）', finalMessage('答', '想过', U, 'stop'), {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: '想过' },
    { type: 'text', text: '答' },
  ],
  usage: U,
  stopReason: 'stop',
})
eq('零值用量形状完整', emptyUsage(), {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0,
})

/* ---------- 单步累积（工具边界 / 重试重置） ---------- */

{
  const acc = new StepAccumulator()
  acc.onThinkingDelta('想')
  acc.onThinkingDelta('一下')
  acc.onTextDelta('你')
  acc.onTextDelta('好')
  eq('增量累计', [acc.thinking, acc.text], ['想一下', '你好'])

  acc.onThinkingEnd('想得更多了')
  eq('thinking_end 用全文覆盖（内核步末重发）', acc.thinking, '想得更多了')

  acc.onStepBoundary()
  eq('工具边界清空本步累积（工具后正文从头计）', [acc.text, acc.thinking], ['', ''])

  acc.onTextDelta('第二轮')
  acc.onStepRetry()
  eq('重试清空本步累积（避免重发内容叠加）', acc.text, '')
}

{
  const acc = new StepAccumulator()
  acc.pushToolResult('load_tools', {
    content: '{"ok":true,"data":{"loadedGroups":["diet"]}}',
    isError: false,
  })
  acc.pushToolResult('search_food', { content: '{"ok":true}', isError: false })
  eq('工具结果按发生顺序记录（load_tools 装载判定要用）', acc.toolResults.length, 2)
  eq('工具名保留', acc.toolResults[0].toolName, 'load_tools')
  eq('结果编码为 content 块（与 pi 的工具结果同形）', acc.toolResults[0].content, [
    { type: 'text', text: '{"ok":true,"data":{"loadedGroups":["diet"]}}' },
  ])
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail === 0 ? 0 : 1)
