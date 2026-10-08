/**
 * check-markdown —— Markdown 渲染器的纯逻辑断言（Node 直跑，不起浏览器）
 *
 * 覆盖 src/utils/markdown.ts：分块（围栏内不切）、代码块、列表、引用、标题降级，
 * 以及表格（GFM 分隔行、列对齐、缺列补空、转义竖线、不误判、流式两阶段升格）。
 * 输入是模型输出，所以「不误判成表格」与「HTML 转义」与「能渲染表格」同等重要。
 *
 * 运行：node scripts/check-markdown.mjs
 */
import { renderBlock, renderMarkdown, splitBlocks } from '../src/utils/markdown.ts'

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
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `\n  实际 ${JSON.stringify(actual)}\n  期望 ${JSON.stringify(expected)}`)
const has = (name, hay, needle) => ok(name, hay.includes(needle), `缺 ${JSON.stringify(needle)}：${hay}`)

/* ---------- 分块 ---------- */

eq('空行分块', splitBlocks('a\n\nb'), ['a', 'b'])
eq('围栏内部不切块', splitBlocks('```\na\n\nb\n```'), ['```\na\n\nb\n```'])
eq('未闭合围栏成一块', splitBlocks('```\na'), ['```\na'])

/* ---------- 回归：既有块形态不被表格分支影响 ---------- */

eq('段落', renderBlock('你好'), '<p>你好</p>')
eq('无序列表', renderBlock('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>')
eq('有序列表', renderBlock('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>')
eq('有序列表（顿号标记）', renderBlock('1、 甲\n2、 乙'), '<ol><li>甲</li><li>乙</li></ol>')
eq('标题降级为粗体', renderBlock('## 小标题'), '<p class="md-h"><b>小标题</b></p>')
eq('引用行', renderBlock('> 引用'), '<p class="md-quote">引用</p>')
has('代码块', renderBlock('```\nx < 1\n```'), '<pre class="md-pre"><code>x &lt; 1</code></pre>')
has('行内代码与粗体', renderBlock('看 `a` 和 **b**'), '<code>a</code> 和 <b>b</b>')
has('HTML 转义', renderBlock('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;')

/* ---------- 表格 ---------- */

const table = (src) => renderMarkdown(src)

eq(
  '基础表格：表头/表体/列对齐',
  table('| 动作 | 组数 |\n| --- | ---: |\n| 深蹲 | 5 |\n| 卧推 | 4 |'),
  '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    '<th style="text-align:left">动作</th><th style="text-align:right">组数</th>' +
    '</tr></thead><tbody>' +
    '<tr><td style="text-align:left">深蹲</td><td style="text-align:right">5</td></tr>' +
    '<tr><td style="text-align:left">卧推</td><td style="text-align:right">4</td></tr>' +
    '</tbody></table></div>',
)

has('省略首尾竖线也能识别', table('a | b\n--- | ---\n1 | 2'), '<th style="text-align:left">a</th>')
has('居中对齐', table('| a |\n| :-: |\n| 1 |'), '<th style="text-align:center">a</th>')
has('单元格内的行内规则', table('| a |\n| --- |\n| **粗** `码` |'), '<td style="text-align:left"><b>粗</b> <code>码</code></td>')
has('单元格 HTML 转义', table('| a |\n| --- |\n| <script>x</script> |'), '&lt;script&gt;x&lt;/script&gt;')
has('单元格里的转义竖线是内容', table('| a |\n| --- |\n| x \\| y |'), '<td style="text-align:left">x | y</td>')
eq(
  '多出的单元格丢弃、缺的补空',
  table('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n| 9 |'),
  '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    '<th style="text-align:left">a</th><th style="text-align:left">b</th>' +
    '</tr></thead><tbody>' +
    '<tr><td style="text-align:left">1</td><td style="text-align:left">2</td></tr>' +
    '<tr><td style="text-align:left">9</td><td style="text-align:left"></td></tr>' +
    '</tbody></table></div>',
)

/* ---------- 不误判 ---------- */

has('没有分隔行就不是表格（段落照旧）', table('| a | b |'), '<p>| a | b |</p>')
has('含竖线的列表项不是表格', table('- 周一 | 跑步\n- 周二 | 游泳'), '<li>周一 | 跑步</li>')
has('表后接段落（不吞掉后续块）', table('| a |\n| --- |\n| 1 |\n\n收尾'), '</table></div><p>收尾</p>')
has('表后接列表', table('| a |\n| --- |\n| 1 |\n- 甲'), '<ul><li>甲</li></ul>')
eq('纯 --- 行（无竖线）仍是段落', renderBlock('---'), '<p>---</p>')

/* ---------- 流式两阶段：分隔行没到之前按段落，到了升格 ---------- */

has('流式·表头先到（还没分隔行）', renderBlock('| a | b |'), '<p>| a | b |</p>')
has('流式·分隔行到达后升格', renderBlock('| a | b |\n| --- | --- |'), '<table class="md-table">')
has('流式·数据行逐行追加', renderBlock('| a |\n| --- |\n| 1 |\n| 2 |'), '<tr><td style="text-align:left">2</td></tr>')

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
