<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ListTodo, MessageCircle, Users } from 'lucide-vue-next'

/**
 * 语音会话 · 10 种版式对照（设计探索页，不属于产品导航）。
 *
 * 同一段长会话（42 分钟、两人、14 句）用 10 种不同的排版思路呈现，用来挑一个定稿。
 * 全部只引用 tokens.css 的令牌，不新增颜色 —— 与工具格、课表、时间线同一套语言。
 * 每种版式有独立 URL：`#/voice-layouts?v=3`，方便直接发给别人看某一版。
 */

interface Seg {
  t: number
  who: 'A' | 'B'
  text: string
}
interface Note {
  kind: 'answer' | 'todo'
  text: string
}

const SESSION = {
  title: '产品周会 · 语音纪要',
  date: '9月17日 周三',
  time: '14:02',
  durationMs: 42 * 60_000 + 18_000,
  sentences: 14,
  words: 1860,
  segments: [
    { t: 0, who: 'A', text: '今天先把上周的进度过一遍，然后重点聊一下下个版本的排期。' },
    { t: 12_000, who: 'B', text: '好。上周我们把导入链路做完了，包含文件解析和去重，测下来三千条大概两分钟。' },
    { t: 31_000, who: 'A', text: '两分钟可以接受。去重是按什么维度？' },
    { t: 38_000, who: 'B', text: '标题加时间，再加正文的前四十个字做指纹。' },
    { t: 47_000, who: 'A', text: '嗯，那如果正文改了但标题没改呢？' },
    { t: 55_000, who: 'B', text: '会当成新条目。这个我们讨论过，先不做模糊匹配。' },
    { t: 66_000, who: 'A', text: '行，先这样。下一个是搜索。' },
    { t: 74_000, who: 'B', text: '搜索现在只有关键词，分词还没接。' },
    { t: 82_000, who: 'A', text: '分词优先级放到下个版本吧。' },
    { t: 90_000, who: 'A', text: '排期的话，下个版本我想留出两周做性能。' },
    { t: 101_000, who: 'B', text: '性能主要卡在哪？' },
    { t: 106_000, who: 'A', text: '长列表渲染和首次加载的索引构建。' },
    { t: 118_000, who: 'B', text: '明白，那我这周先把火焰图跑出来。' },
    { t: 132_000, who: 'A', text: '好，那就这样，散会。' },
  ] as Seg[],
  notes: [
    { kind: 'answer', text: '导入链路完成：解析 + 去重（标题、时间、正文前 40 字做指纹），三千条约两分钟' },
    { kind: 'answer', text: '正文改而标题未改会被判为新条目 —— 有意不做模糊匹配' },
    { kind: 'todo', text: '接入搜索分词（下个版本）' },
    { kind: 'todo', text: '产出长列表渲染与索引构建的火焰图' },
  ] as Note[],
}

const VARIANTS = [
  { id: 1, name: '单栏时间轴', idea: '时间在左、正文在右，最省认知的默认版', width: 'phone' },
  { id: 2, name: '双栏 · 转写 / 纪要', idea: '左边流动的转写，右边同步长出的纪要', width: 'wide' },
  { id: 3, name: '气泡对话流', idea: '按说话人左右分侧，读起来像聊天记录', width: 'phone' },
  { id: 4, name: '段落卡片流', idea: '同一话题的句子收成一张卡，长会话可折', width: 'phone' },
  { id: 5, name: '时间尺', idea: '左侧真实比例时间尺，正文按时间锚定', width: 'phone' },
  { id: 6, name: '说话人分栏', idea: '一人一栏并行推进，适合对照发言', width: 'wide' },
  { id: 7, name: '概览仪表盘', idea: '顶部先给规模，再进正文', width: 'phone' },
  { id: 8, name: '小地图导航', idea: '长文右侧缩略导航，随时知道读到哪', width: 'phone' },
  { id: 9, name: '波形 + 逐句', idea: '上半波形定位，下半句表精读', width: 'phone' },
  { id: 10, name: '杂志式', idea: '大标题 + 多栏正文，像读一篇稿', width: 'wide' },
] as const

const active = ref(1)

const current = computed(() => VARIANTS.find((v) => v.id === active.value)!)

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const fmtLong = (ms: number) => `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`

/** 同一话题的句子聚成段，供卡片流 / 双栏等版式复用。
 *  按**时间间隔**聚合而不是按说话人 —— 两人几乎每句轮换，按说话人分会等于一句一卡。 */
const blocks = computed(() => {
  const out: { t: number; who: string; items: Seg[] }[] = []
  for (const s of SESSION.segments) {
    const last = out[out.length - 1]
    const gap = last ? s.t - last.items[last.items.length - 1]!.t : Number.POSITIVE_INFINITY
    if (last && gap < 10_000) {
      last.items.push(s)
      if (last.who !== s.who) last.who = 'AB'
    } else {
      out.push({ t: s.t, who: s.who, items: [s] })
    }
  }
  return out
})

const speakerLabel = (w: string) => (w === 'A' ? '主讲' : w === 'B' ? '记录' : '对谈')

/** 版式⑤ 的句间留白：按真实间隔给一点节奏感，但**必须封顶** ——
 *  时间戳是毫秒，直接乘系数会得到上千像素的间距（踩过一次）。 */
function gapBefore(i: number): number {
  if (i === 0) return 0
  const diff = SESSION.segments[i]!.t - SESSION.segments[i - 1]!.t
  return Math.min(22, Math.max(0, (diff / 1000) * 0.8))
}

/** 确定性波形：按句子的字符码和算高度，不用随机数（每次渲染都一样） */
const wave = computed(() =>
  SESSION.segments.flatMap((s, si) =>
    Array.from({ length: 9 }, (_, i) => {
      const code = s.text.charCodeAt((si + i) % s.text.length)
      return 18 + ((code * (i + 3)) % 52)
    }),
  ),
)

/** 小地图：每句一条，当前句高亮 */
const readAt = ref(3)

function pick(id: number): void {
  active.value = id
  const url = new URL(location.href)
  url.hash = `#/voice-layouts?v=${id}`
  history.replaceState(null, '', url)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowRight' && active.value < 10) pick(active.value + 1)
  if (e.key === 'ArrowLeft' && active.value > 1) pick(active.value - 1)
}

onMounted(() => {
  const v = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('v'))
  if (v >= 1 && v <= 10) active.value = v
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="lab">
    <!-- 版式切换 -->
    <header class="bar">
      <div class="bar-top">
        <span class="kicker">语音会话 · 版式对照</span>
        <span class="hint">← → 切换 · 每种版式都有独立 URL</span>
      </div>
      <nav class="pills" data-rubber-self>
        <button
          v-for="v in VARIANTS"
          :key="v.id"
          class="pill"
          :class="{ on: v.id === active }"
          @click="pick(v.id)"
        >
          <b class="num">{{ String(v.id).padStart(2, '0') }}</b>
          <span>{{ v.name }}</span>
        </button>
      </nav>
      <p class="idea">{{ current.name }} —— {{ current.idea }}</p>
    </header>

    <!-- 版式舞台 -->
    <div class="stage" :class="current.width">
      <!-- ① 单栏时间轴 -->
      <section v-if="active === 1" class="v v1">
        <div class="vhead">
          <h2>{{ SESSION.title }}</h2>
          <p class="meta">{{ SESSION.date }} {{ SESSION.time }} · {{ fmtLong(SESSION.durationMs) }} · {{ SESSION.sentences }} 句</p>
        </div>
        <ol class="stream">
          <li v-for="s in SESSION.segments" :key="s.t">
            <time class="num">{{ fmt(s.t) }}</time>
            <span class="who">{{ speakerLabel(s.who) }}</span>
            <p>{{ s.text }}</p>
          </li>
        </ol>
      </section>

      <!-- ② 双栏：转写 / 纪要 -->
      <section v-else-if="active === 2" class="v v2">
        <div class="col-l">
          <h3 class="ct">转写</h3>
          <ol class="stream tight">
            <li v-for="s in SESSION.segments" :key="s.t">
              <time class="num">{{ fmt(s.t) }}</time>
              <p>{{ s.text }}</p>
            </li>
          </ol>
        </div>
        <aside class="col-r">
          <h3 class="ct">同步纪要</h3>
          <div v-for="(n, i) in SESSION.notes" :key="i" class="note" :class="n.kind">
            <component :is="n.kind === 'todo' ? ListTodo : MessageCircle" :size="13" />
            <p>{{ n.text }}</p>
          </div>
        </aside>
      </section>

      <!-- ③ 气泡对话流 -->
      <section v-else-if="active === 3" class="v v3">
        <div class="vhead slim">
          <h2>{{ SESSION.title }}</h2>
          <p class="meta">{{ fmtLong(SESSION.durationMs) }} · {{ SESSION.sentences }} 句</p>
        </div>
        <div class="chat">
          <div v-for="s in SESSION.segments" :key="s.t" class="bub" :class="s.who === 'A' ? 'me' : 'them'">
            <span class="bwho">{{ speakerLabel(s.who) }}</span>
            <p>{{ s.text }}</p>
            <time class="num">{{ fmt(s.t) }}</time>
          </div>
        </div>
      </section>

      <!-- ④ 段落卡片流 -->
      <section v-else-if="active === 4" class="v v4">
        <div class="vhead slim">
          <h2>{{ SESSION.title }}</h2>
          <p class="meta">{{ blocks.length }} 段 · {{ SESSION.sentences }} 句</p>
        </div>
        <article v-for="b in blocks" :key="b.t" class="blk">
          <header>
            <span class="who">{{ speakerLabel(b.who) }}</span>
            <time class="num">{{ fmt(b.t) }}</time>
          </header>
          <p v-for="s in b.items" :key="s.t">{{ s.text }}</p>
        </article>
      </section>

      <!-- ⑤ 时间尺 -->
      <section v-else-if="active === 5" class="v v5">
        <div class="vhead slim">
          <h2>{{ SESSION.title }}</h2>
          <p class="meta">按真实时间比例排列</p>
        </div>
        <div class="ruler-wrap">
          <div class="ruler" aria-hidden="true">
            <span v-for="m in 3" :key="m" class="tick" :style="{ top: `${m * 33.3}%` }">
              <i /> <em class="num">{{ fmt((m - 1) * 14 * 60_000) }}</em>
            </span>
          </div>
          <div class="lanes">
            <div
              v-for="(s, i) in SESSION.segments"
              :key="s.t"
              class="lane"
              :class="s.who === 'A' ? 'l' : 'r'"
              :style="{ marginTop: `${gapBefore(i)}px` }"
            >
              <p>{{ s.text }}</p>
              <time class="num">{{ fmt(s.t) }}</time>
            </div>
          </div>
        </div>
      </section>

      <!-- ⑥ 说话人分栏 -->
      <section v-else-if="active === 6" class="v v6">
        <div class="vhead slim">
          <h2>{{ SESSION.title }}</h2>
          <p class="meta"><Users :size="13" /> 2 人</p>
        </div>
        <div class="duo">
          <div v-for="w in ['A', 'B']" :key="w" class="duo-col">
            <h3 class="ct">{{ speakerLabel(w) }}</h3>
            <div v-for="s in SESSION.segments.filter((x) => x.who === w)" :key="s.t" class="duo-item">
              <time class="num">{{ fmt(s.t) }}</time>
              <p>{{ s.text }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ⑦ 概览仪表盘 -->
      <section v-else-if="active === 7" class="v v7">
        <div class="dash">
          <h2>{{ SESSION.title }}</h2>
          <div class="stats">
            <div><b class="num">{{ fmtLong(SESSION.durationMs) }}</b><span>时长</span></div>
            <div><b class="num">{{ SESSION.sentences }}</b><span>句</span></div>
            <div><b class="num">{{ SESSION.words }}</b><span>字</span></div>
            <div><b class="num">{{ SESSION.notes.length }}</b><span>条目</span></div>
          </div>
        </div>
        <ol class="stream tight">
          <li v-for="s in SESSION.segments" :key="s.t">
            <time class="num">{{ fmt(s.t) }}</time>
            <p>{{ s.text }}</p>
          </li>
        </ol>
      </section>

      <!-- ⑧ 小地图导航 -->
      <section v-else-if="active === 8" class="v v8">
        <div class="mini-body">
          <div class="vhead slim">
            <h2>{{ SESSION.title }}</h2>
            <p class="meta">点右侧缩略跳转</p>
          </div>
          <ol class="stream tight">
            <li
              v-for="(s, i) in SESSION.segments"
              :key="s.t"
              :class="{ cur: i === readAt }"
              @click="readAt = i"
            >
              <time class="num">{{ fmt(s.t) }}</time>
              <p>{{ s.text }}</p>
            </li>
          </ol>
        </div>
        <nav class="minimap" aria-label="会话缩略">
          <button
            v-for="(s, i) in SESSION.segments"
            :key="s.t"
            class="mini"
            :class="{ on: i === readAt, them: s.who === 'B' }"
            :style="{ width: `${Math.min(100, 34 + s.text.length * 1.6)}%` }"
            :aria-label="`第 ${i + 1} 句`"
            @click="readAt = i"
          />
        </nav>
      </section>

      <!-- ⑨ 波形 + 逐句 -->
      <section v-else-if="active === 9" class="v v9">
        <div class="wav">
          <div class="wav-bars" aria-hidden="true">
            <i v-for="(h, i) in wave" :key="i" :style="{ height: `${h}%` }" :class="{ past: i < 42 }" />
          </div>
          <div class="wav-foot">
            <span class="num">{{ fmt(31_000) }}</span>
            <span class="num t-3">{{ fmtLong(SESSION.durationMs) }}</span>
          </div>
        </div>
        <ol class="rows">
          <li v-for="s in SESSION.segments" :key="s.t">
            <time class="num">{{ fmt(s.t) }}</time>
            <span class="who">{{ speakerLabel(s.who) }}</span>
            <p>{{ s.text }}</p>
          </li>
        </ol>
      </section>

      <!-- ⑩ 杂志式 -->
      <section v-else class="v v10">
        <header class="mag-head">
          <span class="kicker">会话记录</span>
          <h2>{{ SESSION.title }}</h2>
          <p class="byline">{{ SESSION.date }} · {{ fmtLong(SESSION.durationMs) }} · 2 人 · {{ SESSION.words }} 字</p>
        </header>
        <div class="mag-cols">
          <p v-for="(s, i) in SESSION.segments" :key="s.t" :class="{ lead: i === 0 }">{{ s.text }}</p>
        </div>
        <footer class="mag-foot">
          <div v-for="(n, i) in SESSION.notes" :key="i" class="mag-note">
            <component :is="n.kind === 'todo' ? ListTodo : MessageCircle" :size="13" />
            <span>{{ n.text }}</span>
          </div>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* ===== 对照页外壳（不属于任何版式） ===== */
.lab {
  min-height: 100dvh;
  padding-bottom: 60px;
}

.bar {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 16px var(--page-pad-x) 12px;
  background: var(--surface-translucent);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--line);
}

.bar-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.kicker {
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.hint {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.pills {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}

.pills::-webkit-scrollbar {
  display: none;
}

.pill {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 11px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.pill b {
  font-weight: 800;
  color: var(--text-3);
}

.pill.on {
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--led-shopping);
}

.pill.on b {
  color: var(--led-shopping);
}

.idea {
  margin-top: 9px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stage {
  margin: 18px auto 0;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
}

.stage.phone {
  max-width: 470px;
}

.stage.wide {
  max-width: 880px;
}

/* ===== 版式共用件 ===== */
.v {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.vhead h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  color: var(--text-1);
}

.vhead.slim h2 {
  font-size: var(--fs-headline);
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.who {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--led-shopping);
}

.ct {
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
  margin-bottom: 10px;
}

.num {
  font-variant-numeric: tabular-nums;
}

/* ===== ① 单栏时间轴 ===== */
.stream {
  display: flex;
  flex-direction: column;
}

.stream li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
}

.stream li:last-child {
  border-bottom: none;
}

.stream.tight li {
  padding: 9px 0;
}

.stream time {
  flex: none;
  width: 40px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.stream p {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-callout);
  line-height: 1.6;
  color: var(--text-1);
}

/* ===== ② 双栏 ===== */
.v2 {
  flex-direction: row;
  align-items: flex-start;
  gap: 22px;
}

.col-l {
  flex: 1.35;
  min-width: 0;
}

.col-r {
  flex: 1;
  min-width: 0;
  position: sticky;
  top: 130px;
  padding: 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.note {
  display: flex;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-caption);
  line-height: 1.55;
  color: var(--text-1);
}

.note:last-child {
  border-bottom: none;
}

.note svg {
  flex: none;
  margin-top: 2px;
  color: var(--text-3);
}

.note.todo svg {
  color: var(--cat-work);
}

/* ===== ③ 气泡 ===== */
.chat {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bub {
  max-width: 84%;
  padding: 10px 13px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.bub p {
  font-size: var(--fs-callout);
  line-height: 1.6;
  color: var(--text-1);
}

.bub time {
  display: block;
  margin-top: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.bub.me {
  align-self: flex-end;
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
}

.bub.them {
  align-self: flex-start;
}

.bwho {
  display: block;
  margin-bottom: 3px;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-3);
}

.bub.me .bwho {
  color: var(--led-shopping);
}

/* ===== ④ 卡片流 ===== */
.blk {
  padding: 15px 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.blk header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.blk header time {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.blk p {
  font-size: var(--fs-callout);
  line-height: 1.65;
  color: var(--text-1);
}

.blk p + p {
  margin-top: 7px;
}

/* ===== ⑤ 时间尺 ===== */
.ruler-wrap {
  position: relative;
  padding-left: 46px;
}

.ruler {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 46px;
  border-right: 1px solid var(--line);
}

.tick {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tick i {
  width: 7px;
  height: 1px;
  background: var(--line-strong);
}

.tick em {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.lanes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lane {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 11px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.lane p {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  line-height: 1.55;
  color: var(--text-1);
}

.lane time {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.lane.r {
  margin-left: 26px;
}

/* ===== ⑥ 说话人分栏 ===== */
.duo {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.duo-col {
  flex: 1;
  min-width: 0;
  padding: 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.duo-item + .duo-item {
  margin-top: 11px;
}

.duo-item time {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.duo-item p {
  margin-top: 2px;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-1);
}

/* ===== ⑦ 仪表盘 ===== */
.dash {
  padding: 18px;
  border-radius: var(--radius-xl);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.dash h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  color: var(--text-1);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-top: 16px;
}

.stats div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stats b {
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-1);
  letter-spacing: -0.02em;
}

.stats span {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ===== ⑧ 小地图 ===== */
.v8 {
  flex-direction: row;
  gap: 14px;
  align-items: flex-start;
}

.mini-body {
  flex: 1;
  min-width: 0;
}

.mini-body .stream li {
  cursor: pointer;
  border-radius: 8px;
  padding-left: 8px;
  padding-right: 8px;
  margin-left: -8px;
}

.mini-body .stream li.cur {
  background: color-mix(in srgb, var(--led-shopping) 10%, transparent);
}

.minimap {
  flex: none;
  width: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  padding-top: 74px;
  position: sticky;
  top: 130px;
}

.mini {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
}

.mini.them {
  background: var(--line);
}

.mini.on {
  background: var(--led-shopping);
  height: 6px;
}

/* ===== ⑨ 波形 ===== */
.wav {
  padding: 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.wav-bars {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 68px;
}

.wav-bars i {
  flex: 1;
  min-width: 1px;
  border-radius: 2px;
  background: var(--line-strong);
}

.wav-bars i.past {
  background: color-mix(in srgb, var(--led-shopping) 55%, transparent);
}

.wav-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.rows {
  display: flex;
  flex-direction: column;
}

.rows li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.rows li:last-child {
  border-bottom: none;
}

.rows time {
  flex: none;
  width: 40px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.rows p {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-1);
}

/* ===== ⑩ 杂志式 ===== */
.v10 {
  gap: 18px;
}

.mag-head {
  padding-bottom: 14px;
  border-bottom: 2px solid var(--text-1);
}

.mag-head h2 {
  margin: 6px 0 8px;
  font-size: var(--fs-display-s);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: var(--text-1);
  text-wrap: balance;
}

.byline {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.mag-cols {
  column-count: 2;
  column-gap: 26px;
}

.mag-cols p {
  font-size: var(--fs-callout);
  line-height: 1.75;
  color: var(--text-1);
  break-inside: avoid;
}

.mag-cols p + p {
  margin-top: 10px;
}

.mag-cols .lead {
  font-size: var(--fs-title3);
  font-weight: 600;
  line-height: 1.5;
}

.mag-cols .lead::first-letter {
  float: left;
  margin: 4px 8px 0 0;
  font-size: 46px;
  line-height: 0.9;
  font-weight: 700;
  color: var(--led-shopping);
}

.mag-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.mag-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  flex: 1 1 320px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--led-shopping) 8%, transparent);
  font-size: var(--fs-caption);
  line-height: 1.55;
  color: var(--text-1);
}

.mag-note svg {
  flex: none;
  margin-top: 2px;
  color: var(--led-shopping);
}

/* 窄屏兜底：宽版式在小屏上退回单栏，不横向溢出 */
@media (max-width: 720px) {
  .v2,
  .v6,
  .v8 {
    flex-direction: column;
  }

  .col-r,
  .minimap {
    position: static;
    width: 100%;
  }

  .minimap {
    flex-direction: row;
    align-items: center;
    padding-top: 0;
  }

  .mini {
    flex: none;
  }

  .duo {
    flex-direction: column;
  }

  .mag-cols {
    column-count: 1;
  }

  .lane.r {
    margin-left: 0;
  }

  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
