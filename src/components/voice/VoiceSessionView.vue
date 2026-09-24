<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  Keyboard,
  ListOrdered,
  ListTodo,
  MessageCircle,
  Mic,
  Pause,
  Play,
  Square,
  Utensils,
  X,
} from 'lucide-vue-next'

import MdText from '@/components/common/MdText.vue'
import TimeSpine from './TimeSpine.vue'
import VoiceMemosSheet from './VoiceMemosSheet.vue'
import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import {
  cancelSession,
  discardRecovered,
  finishSpeaking,
  minimize,
  recoverSubmit,
  setAutoSettle,
  speakMemo,
  startRecording,
  voice,
  writeMemoAll,
  writeMemoItem,
} from '@/system/voiceRuntime'
import type { MemoSummaryItem, VoiceMemo } from '@/types'

/**
 * 语音会话视图（App 根部常驻挂载，单例 runtime 驱动）。
 * 四态：ready 待机 / recording 转写中 / memo 纪要详情（全览/转文字分段）/ processing 在 memo 内提示。
 * 文本区左右 padding 用 --page-pad-x，与全应用页面栅格对齐。
 */

const ai = useAiStore()
const toast = useToast()

/* ---------- 计时 ---------- */

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/* ---------- 转写视图 ---------- */

/** 喂给时间脊的形状（与 TimeSpine 的 SpineSeg 结构一致） */
interface SpineSeg {
  t: number
  durMs?: number
  who: string
  text: string
  partial?: boolean
}

/**
 * 把句子喂给时间脊。ASR 不给说话人，所以只有一条轨道 —— 脊本身支持多轨，
 * 等哪天接上说话人分离，这里换个字段就有第二条了。
 */
const spineSegs = computed<SpineSeg[]>(() =>
  voice.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  })),
)

/** 纪要里的条目本来就带 refs（指向句 idx），直接当锚点钉在轴上 */
const memoSpineSegs = computed<SpineSeg[]>(() =>
  (memo.value?.sentences ?? []).map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  })),
)

const memoPins = computed(() =>
  (memo.value?.summary ?? []).flatMap((it) => {
    const ref = it.refs[0]
    const pos = ref == null ? undefined : posOfSentenceIdx.value.get(ref)
    return pos == null
      ? []
      : [{ idx: pos, kind: it.kind === 'todo' ? ('todo' as const) : ('answer' as const), text: it.text }]
  }),
)

/** 转写中的脊：已定稿句 + 那句未定稿（灰块在生长） */
const liveSpineSegs = computed<SpineSeg[]>(() => {
  const out: SpineSeg[] = [...spineSegs.value]
  if (voice.partial) {
    out.push({ t: voice.elapsedMs, who: '我', text: voice.partial, partial: true })
  }
  return out
})

const liveHint = computed(() => {
  if (voice.lastError) return voice.lastError
  if (voice.autoSettle && voice.status === 'recording') {
    const left = Math.ceil(voice.settleRemainMs / 1000)
    return `✓ 已逐句保存 · 满 3:00 自动结算（剩 ${left}s），录音不中断`
  }
  return '✓ 已逐句保存，中断可恢复'
})

/* ---------- 纪要详情 ---------- */

const tab = ref<'ov' | 'tr'>('ov')

/** 纪要详情视图的当前纪要（供模板窄化） */
const memo = computed<VoiceMemo | null>(() => (voice.view === 'memo' ? voice.currentMemo : null))

function switchTab(t: 'ov' | 'tr'): void {
  tab.value = t
}

/* 引用角标 → 切到精读并高亮那一句 */
const focusIdx = ref<number | null>(null)
let focusTimer: number | null = null

/** refs 里存的是句 idx，时间脊按数组位置索引 —— 这两个不一定相等，必须映射 */
const posOfSentenceIdx = computed(() => {
  const m = new Map<number, number>()
  ;(voice.currentMemo?.sentences ?? []).forEach((s, i) => m.set(s.idx, i))
  return m
})

function focusAt(pos: number, switchTab = true): void {
  if (pos < 0) return
  if (switchTab) tab.value = 'tr'
  focusIdx.value = pos
  if (focusTimer != null) clearTimeout(focusTimer)
  focusTimer = window.setTimeout(() => {
    focusIdx.value = null
  }, 2400)
}

function onCite(refs: number[]): void {
  if (refs.length === 0) return
  const target = posOfSentenceIdx.value.get(Math.min(...refs.filter((n) => n >= 0)))
  if (target != null) focusAt(target)
}

/* ---------- 重放 ---------- */

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const curMs = ref(0)

function togglePlay(): void {
  const a = audioEl.value
  if (!a) return
  if (a.paused) void a.play()
  else a.pause()
}

function onTime(): void {
  curMs.value = (audioEl.value?.currentTime ?? 0) * 1000
}

function seekBar(e: MouseEvent): void {
  const a = audioEl.value
  if (!a || !voice.durationMs) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  a.currentTime = ((e.clientX - r.left) / r.width) * (voice.durationMs / 1000)
  void a.play()
}

/** 时间脊上的 seek：跳音频到该时刻 */
function onSpineSeek(ms: number): void {
  const a = audioEl.value
  if (!a || !voice.audioUrl) return
  a.currentTime = ms / 1000
  void a.play()
}

/** 播放中的当前句位置（卡拉OK式跟随高亮） */
const playingPos = computed(() => {
  const memo = voice.currentMemo
  if (!memo || !playing.value) return -1
  let pos = -1
  memo.sentences.forEach((s, i) => {
    if (curMs.value >= s.startMs) pos = i
  })
  return pos
})

/** 脊上要高亮的句：引用跳转优先，其次播放跟随 */
const spineActive = computed<number | undefined>(
  () => focusIdx.value ?? (playingPos.value >= 0 ? playingPos.value : undefined),
)

/* ---------- 写入 ---------- */

const writing = ref(false)

async function onWriteAll(memo: VoiceMemo): Promise<void> {
  writing.value = true
  try {
    const n = await writeMemoAll(memo)
    toast.toast(n > 0 ? `已写入 ${n} 项` : '没有待写入的条目')
  } finally {
    writing.value = false
  }
}

async function onWriteItem(memo: VoiceMemo, item: MemoSummaryItem): Promise<void> {
  if (await writeMemoItem(memo, item)) toast.toast('已写入')
}

function onSpeak(memo: VoiceMemo): void {
  void speakMemo(memo)
}

/* ---------- 键盘输入回退 ---------- */

const kbdOpen = ref(false)
const kbdText = ref('')
const kbdSending = ref(false)

async function sendKbd(): Promise<void> {
  const text = kbdText.value.trim()
  if (!text || kbdSending.value) return
  kbdSending.value = true
  try {
    await ai.sendText(text)
    kbdText.value = ''
  } finally {
    kbdSending.value = false
  }
}

/** 键盘输入后最近一条助手回复（流式跟随） */
const kbdReply = computed(() => {
  for (let i = ai.messages.length - 1; i >= 0; i--) {
    const m = ai.messages[i]
    if (m && m.role === 'assistant') return m
  }
  return null
})

/* ---------- 全部纪要 ---------- */

const memosOpen = ref(false)

function onPickMemo(memo: VoiceMemo): void {
  memosOpen.value = false
  if (voice.status === 'recording') {
    toast.toast('转写中，先完成或取消当前转写')
    return
  }
  import('@/system/voiceRuntime').then(({ openMemoById }) => void openMemoById(memo.id))
}

onBeforeUnmount(() => {
  if (focusTimer != null) clearTimeout(focusTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="vs">
      <section v-if="voice.view !== 'closed' && !voice.minimized" class="vs-root" aria-label="语音对话">
        <!-- ===== 顶栏 ===== -->
        <header class="vs-top">
          <button class="vs-tbtn" aria-label="收起为浮条" @click="minimize">
            <template v-if="voice.status === 'idle'">
              <X :size="17" />
            </template>
            <ChevronDown v-else :size="19" />
          </button>
          <span class="vs-title">
            语音对话
            <small v-if="voice.view === 'memo' && voice.currentMemo">{{ voice.currentMemo.title }}</small>
            <small v-else-if="voice.status === 'recording' || voice.status === 'processing'">
              与 AI 对话同会话{{ voice.segmentCount > 0 ? ` · 已结算 ${voice.segmentCount} 段` : '' }}
            </small>
            <small v-else>逐句实时留档 · 中断可恢复</small>
          </span>
          <button class="vs-tbtn wide" @click="memosOpen = true">
            <ListOrdered :size="14" /> 全部纪要
          </button>
        </header>

        <!-- ===== 待机 ===== -->
        <template v-if="voice.view === 'ready'">
          <div class="ready">
            <!-- 崩溃恢复提示 -->
            <div v-if="voice.recovered" class="recover">
              <p>
                上次有 <b>{{ voice.recovered.sentences.length }}</b> 句未整理的转写
                <span class="t-3">（{{ new Date(voice.recovered.startedAt).toTimeString().slice(0, 5) }}）</span>
              </p>
              <div class="rec-acts">
                <button class="rbtn primary" @click="recoverSubmit">补交整理</button>
                <button class="rbtn" @click="discardRecovered">丢弃</button>
              </div>
            </div>
            <div class="ready-orb" aria-hidden="true">
              <AudioLines :size="44" />
            </div>
            <p class="ready-cap">轻点麦克风开始说话</p>
            <button class="mic-big start" aria-label="开始说话" @click="startRecording">
              <Mic :size="28" />
            </button>
            <p v-if="voice.lastError" class="err t-2">{{ voice.lastError }}</p>
          </div>
        </template>

        <!-- ===== 转写中 ===== -->
        <template v-else-if="voice.view === 'session'">
          <div class="live">
            <span class="wave" aria-hidden="true"><i v-for="i in 7" :key="i" /></span>
            <span class="lv-t">
              <b>
                <i v-if="voice.status === 'recording'" class="rec" />
                {{ voice.status === 'recording' ? '聆听中 · 实时转写' : '已说完' }}
              </b>
              <em>{{ liveHint }}</em>
            </span>
            <span class="num time">{{ fmtMs(voice.elapsedMs) }}</span>
          </div>
          <!-- 转写正文：时间脊的精读形态（顶部保留按真实比例的定位带） -->
          <div class="tr" data-rubber-self>
            <TimeSpine
              size="full"
              mode="read"
              :segments="liveSpineSegs"
              :head-ms="voice.elapsedMs"
              :fold-silence-over="12"
            />
          </div>
          <footer class="foot">
            <button class="mode-chip" :class="{ on: voice.autoSettle }" @click="setAutoSettle(!voice.autoSettle)">
              每 3 分钟自动整理<span class="sw" />
            </button>
            <div class="btns">
              <button class="side danger" @click="cancelSession">
                <X :size="13" /> 取消
              </button>
              <button
                v-if="voice.status === 'recording'"
                class="mic-big rec"
                aria-label="完成说话"
                @click="finishSpeaking"
              >
                <Square :size="22" />
              </button>
              <span v-else class="mic-big rec dimmed"><Square :size="22" /></span>
              <button class="side" :disabled="voice.status !== 'recording'" @click="finishSpeaking">
                <Check :size="13" /> 完成，整理纪要
              </button>
            </div>
            <button class="kbd-toggle t-3" @click="kbdOpen = !kbdOpen">
              <Keyboard :size="13" /> {{ kbdOpen ? '收起键盘' : '键盘补充' }}
            </button>
            <div v-if="kbdOpen" class="kbd-bar">
              <input v-model="kbdText" type="text" placeholder="改用键盘输入…" @keydown.enter="sendKbd">
              <button class="kb-send" :disabled="kbdSending" @click="sendKbd"><ArrowUp :size="16" /></button>
            </div>
            <div v-if="kbdOpen && kbdReply" class="kbd-reply">
              <MdText v-if="kbdReply.text" :text="kbdReply.text" :streaming="kbdReply.streaming" />
            </div>
          </footer>
        </template>

        <!-- ===== 纪要详情 ===== -->
        <template v-else-if="voice.view === 'memo'">
          <div class="body" data-rubber-self>
            <p v-if="!memo" class="vs-hint">
              {{ voice.processingCount > 0 || voice.status === 'processing' ? 'AI 正在整理纪要…' : '这段没有产生纪要' }}
            </p>
            <template v-else>
              <!-- 纪要头（平铺） -->
              <div class="vm-head">
                <span class="vm-ic"><FileText :size="17" /></span>
                <span class="vm-t">
                  <b>{{ memo.title }}</b>
                  <em>
                    {{ new Date(memo.createdAt).toTimeString().slice(0, 5) }} ·
                    {{ fmtMs(memo.durationMs) }} · {{ memo.words }} 字 ·
                    {{ memo.sentences.length }} 句
                  </em>
                </span>
              </div>

              <!-- 重放条 -->
              <div v-if="memo.audioPath" class="player">
                <button class="pl-btn" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
                  <Play v-if="!playing" :size="15" />
                  <Pause v-else :size="15" />
                </button>
                <span class="pl-cur num">{{ fmtMs(curMs) }}</span>
                <div class="pl-bar" @click="seekBar">
                  <i :style="{ width: `${Math.min(100, (curMs / Math.max(1, memo.durationMs)) * 100)}%` }" />
                  <b :style="{ left: `${Math.min(100, (curMs / Math.max(1, memo.durationMs)) * 100)}%` }" />
                </div>
                <span class="pl-dur num">{{ fmtMs(memo.durationMs) }}</span>
              </div>

              <!-- 分段 -->
              <div class="seg" :class="{ right: tab === 'tr' }">
                <span class="sthumb" />
                <button :class="{ on: tab === 'ov' }" @click="switchTab('ov')">全览</button>
                <button :class="{ on: tab === 'tr' }" @click="switchTab('tr')">转文字</button>
              </div>

              <!-- 会话结构：整场压成一屏，块宽 = 说话时长，纪要是钉在轴上的锚点 -->
              <section class="ov-sec spine-sec">
                <h5>
                  会话结构
                  <em class="num">{{ memo.sentences.length }} 句 · {{ fmtMs(memo.durationMs) }}</em>
                </h5>
                <TimeSpine
                  size="full"
                  mode="structure"
                  :segments="memoSpineSegs"
                  :total-ms="memo.durationMs"
                  :pins="memoPins"
                  :head-ms="playing ? curMs : undefined"
                  :active-idx="spineActive"
                  @seek="onSpineSeek"
                  @pick="focusAt"
                />
              </section>

              <!-- 整理中（轻提示行） -->
              <div v-if="voice.status === 'processing' || voice.processingCount > 0" class="proc">
                <span class="spin" />
                <span>
                  <b>AI 正在整理纪要…</b>
                  <em>转写已保存，整理不会丢内容</em>
                </span>
              </div>

              <!-- 全览 -->
              <template v-else-if="tab === 'ov'">
                <p v-if="memo.summary.length === 0" class="vs-hint">
                  这段没有提取出结构化条目，转写内容见「转文字」。
                </p>
                <section v-if="memo.summary.length > 0" class="ov-sec">
                  <h5>总结</h5>
                  <div v-for="(it, i) in memo.summary" :key="i" class="sum-li">
                <i class="ic" :class="`i-${it.kind}`">
                  <Utensils v-if="it.kind === 'food'" :size="13" />
                  <ListTodo v-else-if="it.kind === 'todo'" :size="13" />
                  <MessageCircle v-else :size="13" />
                </i>
                    <span class="sum-body">
                      <span class="md-line"><MdText :text="it.text" /><button
                        v-if="it.refs.length"
                        class="cite"
                        :aria-label="`跳到第 ${it.refs.map((r) => r + 1).join('、')} 句`"
                        @click="onCite(it.refs)"
                      >{{ it.refs.map((r) => r + 1).join('') }}</button></span>
                      <em v-if="it.note" class="sub">{{ it.note }}</em>
                    </span>
                  </div>
                </section>
                <section v-if="memo.summary.some((it) => it.kind === 'todo' && it.todo)" class="ov-sec">
                  <h5>待办事项</h5>
                  <div
                    v-for="(it, i) in memo.summary.filter((x) => x.kind === 'todo' && x.todo)"
                    :key="i"
                    class="todo-li"
                  >
                    <span class="cb" :class="{ done: it.written }" />
                    <span class="tt">
                      {{ it.todo!.title }}
                      <em v-if="it.todo!.startMin != null">
                        {{ String(Math.floor(it.todo!.startMin! / 60)).padStart(2, '0') }}:{{ String(it.todo!.startMin! % 60).padStart(2, '0') }}
                      </em>
                    </span>
                    <button v-if="!it.written" class="wbtn" @click="onWriteItem(memo, it)">写入</button>
                    <span v-else class="done-mark"><Check :size="14" /></span>
                  </div>
                </section>
                <div class="acts-flat">
                  <button class="commit" :disabled="writing" @click="onWriteAll(memo)">
                    <Check :size="15" /> 全部写入
                  </button>
                  <button class="ghost" @click="onSpeak(memo)">
                    <span v-if="voice.speaking" class="mini-wave"><i /><i /><i /></span>
                    <Play v-else :size="15" />
                    {{ voice.speaking ? '停止朗读' : '朗读纪要' }}
                  </button>
                </div>
              </template>

              <!-- 转文字：脊的精读形态（顶带定位 + 句表 + 句尾锚点角标） -->
              <template v-else>
                <section class="ov-sec tr-sec">
                  <TimeSpine
                    size="full"
                    mode="read"
                    :segments="memoSpineSegs"
                    :total-ms="memo.durationMs"
                    :pins="memoPins"
                    :head-ms="playing ? curMs : undefined"
                    :active-idx="spineActive"
                    :fold-silence-over="12"
                    @seek="onSpineSeek"
                    @pick="focusAt"
                  />
                  <p class="vs-hint">点句子跳到音频该句 · 点句尾角标对照总结</p>
                </section>
              </template>
            </template>
          </div>
          <!-- 底部控制：继续说（新一段，独立纪要） -->
          <footer class="foot">
            <div class="btns">
              <button class="mic-big start" aria-label="开始说话" @click="startRecording">
                <Mic :size="26" />
              </button>
              <button class="side" @click="kbdOpen = !kbdOpen">
                <Keyboard :size="13" /> 键盘补充
              </button>
            </div>
            <p v-if="voice.lastError" class="err t-2">{{ voice.lastError }}</p>
          </footer>
        </template>

        <VoiceMemosSheet :open="memosOpen" @close="memosOpen = false" @pick="onPickMemo" />
        <audio
          v-if="memo?.audioPath"
          ref="audioEl"
          :src="memo.audioPath"
          @play="playing = true"
          @pause="playing = false"
          @timeupdate="onTime"
        />
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vs-root {
  position: fixed;
  inset: 0;
  z-index: 65;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  max-width: var(--frame-max);
  margin: 0 auto;
}

.vs-enter-active,
.vs-leave-active {
  transition:
    opacity var(--dur-sheet) var(--ease-sheet),
    transform var(--dur-sheet) var(--ease-sheet);
}

.vs-enter-from,
.vs-leave-to {
  opacity: 0;
  transform: translateY(24px);
}

/* ===== 顶栏 ===== */
.vs-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(var(--safe-top) + 8px) 14px 6px;
}

.vs-tbtn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex: none;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

.vs-tbtn.wide {
  width: auto;
  border-radius: var(--radius-full);
  padding: 0 12px;
  gap: 5px;
  display: inline-flex;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.vs-title {
  flex: 1;
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vs-title small {
  display: block;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
  margin-top: 1px;
}

/* ===== 待机 ===== */
.ready {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 0 var(--page-pad-x) calc(var(--safe-bottom) + 30px);
  text-align: center;
}

.recover {
  width: 100%;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
}

.recover p {
  color: var(--text-2);
}

.rec-acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.rbtn {
  flex: 1;
  height: 34px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.rbtn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

/* 待机态的呼吸圆：语音域色的淡彩底 + 同色波形图标。
   原先是一颗四层径向渐变的霓虹球 + 零偏移彩色光晕 —— 那种写法在全应用里独一份，
   且光晕是纯装饰。这里回到与工具格同一套语言，动画保留（它表达「在等你开口」）。 */
.ready-orb {
  width: 110px;
  height: 110px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--led-shopping);
  animation: vbreathe 4s var(--ease-standard) infinite;
}

@keyframes vbreathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.04);
  }
}

.ready-cap {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

.err {
  font-size: var(--fs-caption);
  color: var(--danger);
}

/* ===== 声纹状态带 ===== */
.live {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px var(--page-pad-x) 4px;
  padding: 10px 14px;
  background: var(--surface);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
}

.wave {
  display: flex;
  align-items: center;
  gap: 2.5px;
  height: 22px;
  flex: none;
}

.wave i {
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
  animation: wv 1s ease-in-out infinite;
}

.wave i:nth-child(odd) {
  height: 70%;
}

.wave i:nth-child(even) {
  height: 100%;
}

.wave i:nth-child(2) {
  animation-delay: 0.12s;
}

.wave i:nth-child(3) {
  animation-delay: 0.24s;
}

.wave i:nth-child(4) {
  animation-delay: 0.08s;
}

.wave i:nth-child(6) {
  animation-delay: 0.18s;
}

@keyframes wv {
  0%,
  100% {
    transform: scaleY(0.4);
  }
  50% {
    transform: scaleY(1);
  }
}

.lv-t {
  flex: 1;
  min-width: 0;
}

.lv-t b {
  font-size: var(--fs-footnote);
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
}

.lv-t b .rec {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  animation: wvb 1.4s ease-in-out infinite;
  flex: none;
}

@keyframes wvb {
  50% {
    opacity: 0.35;
  }
}

.lv-t em {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  display: block;
  margin-top: 1px;
}

.time {
  font-size: 15px;
  font-weight: 300;
  letter-spacing: -0.5px;
  flex: none;
}

/* ===== 转写区（page padding 对齐全应用） ===== */
.tr {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px var(--page-pad-x) 10px;
  scrollbar-width: none;
}

.tr::-webkit-scrollbar {
  display: none;
}

.tl {
  display: flex;
  gap: 10px;
  padding: 7px 0;
  font-size: var(--fs-callout);
  line-height: 1.65;
}

.tl + .tl {
  border-top: 0.5px solid var(--line);
}

.tl time {
  flex: none;
  width: 38px;
  padding-top: 2px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.tl p {
  flex: 1;
  min-width: 0;
  border-radius: 6px;
  padding: 1px 4px;
  margin: -1px -4px;
}

.tl.partial p {
  color: var(--text-2);
}

.tl.partial .caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--text-3);
  vertical-align: -0.12em;
  margin-left: 2px;
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* ===== 纪要详情 ===== */
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px var(--page-pad-x) calc(var(--safe-bottom) + 20px);
  scrollbar-width: none;
}

.body::-webkit-scrollbar {
  display: none;
}

.vm-head {
  display: flex;
  gap: 10px;
  padding: 2px 2px 12px;
}

.vm-ic {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--led-shopping);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.vm-t {
  flex: 1;
  min-width: 0;
}

.vm-t b {
  font-size: var(--fs-body);
  font-weight: 800;
  letter-spacing: -0.3px;
  display: block;
  line-height: 1.35;
}

.vm-t em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
  display: block;
  margin-top: 2px;
}

/* 重放条：可交互控件 → 卡片 */
.player {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  background: var(--surface);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
}

.pl-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: none;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pl-cur,
.pl-dur {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--fs-micro);
  color: var(--text-2);
  flex: none;
}

.pl-bar {
  flex: 1;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  position: relative;
  cursor: pointer;
}

.pl-bar i {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.pl-bar b {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-thumb);
  transform: translate(-50%, -50%);
}

/* 分段控件 */
.seg {
  position: relative;
  display: flex;
  margin-top: 12px;
  background: var(--surface-2);
  border-radius: 9px;
  padding: 2px;
}

.seg .sthumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  background: var(--surface);
  border-radius: 7px;
  box-shadow: var(--shadow-thumb);
  transition: transform var(--dur-base) var(--ease-standard);
}

.seg.right .sthumb {
  transform: translateX(100%);
}

.seg button {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 28px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  border-radius: 7px;
}

.seg button.on {
  color: var(--text-1);
  font-weight: 700;
}

/* 整理中（轻提示行，无卡片壳） */
.proc {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 2px;
}

.spin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2.5px solid var(--line);
  border-top-color: var(--accent);
  animation: rot 1s linear infinite;
  flex: none;
}

@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}

.proc b {
  font-size: var(--fs-footnote);
  font-weight: 700;
  display: block;
}

.proc em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 总结（平铺 + Markdown） */
.ov-sec {
  margin-top: 14px;
}

.ov-sec > h5 {
  font-size: var(--fs-micro);
  font-weight: 800;
  color: var(--text-3);
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}

.sum-li {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  font-size: var(--fs-subhead);
  line-height: 1.6;
}

.sum-li + .sum-li {
  border-top: 0.5px solid var(--line);
}

.sum-li .ic {
  flex: none;
  width: 17px;
  height: 17px;
  margin-top: 2px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
}

.i-food {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.i-todo {
  background: var(--accent-soft);
  color: var(--accent);
}

.i-note {
  background: var(--surface-2);
  color: var(--text-2);
}

.sum-body {
  flex: 1;
  min-width: 0;
}

.md-line {
  display: block;
}

.sub {
  font-style: normal;
  color: var(--text-3);
  font-size: var(--fs-caption);
  display: block;
  margin-top: 1px;
}

.cite {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  margin-left: 4px;
  border-radius: 5px;
  vertical-align: 2px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 800;
}

/* 待办行卡 */
.todo-li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  margin-top: 8px;
}

.todo-li .cb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  flex: none;
}

.todo-li .cb.done {
  background: var(--ok);
  border-color: var(--ok);
}

.todo-li .tt {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: 600;
  line-height: 1.45;
}

.todo-li .tt em {
  font-style: normal;
  display: block;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: 500;
  margin-top: 1px;
}

.todo-li .wbtn {
  flex: none;
  height: 26px;
  padding: 0 11px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 700;
}

.done-mark {
  color: var(--ok);
  font-weight: 800;
  flex: none;
}

/* 底部操作（平铺按钮组） */
.acts-flat {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.acts-flat button {
  flex: 1;
  height: 40px;
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.acts-flat .commit {
  background: var(--accent);
  color: var(--on-accent);
}

.acts-flat .commit:disabled {
  opacity: 0.5;
}

.acts-flat .ghost {
  background: var(--surface-2);
  color: var(--text-1);
}

.mini-wave {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}

.mini-wave i {
  width: 2.5px;
  border-radius: 2px;
  background: currentColor;
  animation: wv 0.9s ease-in-out infinite;
}

.mini-wave i:nth-child(1) {
  height: 40%;
}

.mini-wave i:nth-child(2) {
  height: 90%;
  animation-delay: 0.15s;
}

.mini-wave i:nth-child(3) {
  height: 60%;
  animation-delay: 0.3s;
}

/* 转文字页：句子 + 总结 block */
.tr-sec {
  margin-top: 8px;
}

.tl.seek {
  cursor: pointer;
}

.tl.seek:active {
  background: var(--surface-2);
}

.tl.seek.now {
  background: var(--accent-soft);
  border-radius: 10px;
}

.tl.seek.flash p {
  animation: flashhl 0.65s ease-in-out 3;
}

@keyframes flashhl {
  0%,
  100% {
    background: transparent;
  }
  45% {
    background: var(--accent-soft);
  }
}

.at {
  display: none;
  color: var(--text-3);
  font-size: var(--fs-micro);
}

.tl.seek:hover .at {
  display: inline;
}

.sblock {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 6px 0 8px 48px;
  padding: 8px 11px;
  background: var(--accent-soft);
  border-radius: 12px;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.sb-ic {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background: var(--surface);
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.sblock p {
  flex: 1;
  min-width: 0;
}

/* 11px 的说明文字用 --text-3 只有约 2.3:1，读不清；提到 --text-2（≈4.9:1） */
.vs-hint {
  font-size: var(--fs-micro);
  color: var(--text-2);
  margin-top: 8px;
}

/* ===== 底部控制（转写视图） ===== */
.foot {
  flex: none;
  padding: 10px var(--page-pad-x) calc(var(--safe-bottom) + 18px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.mode-chip .sw {
  width: 24px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  position: relative;
}

.mode-chip .sw::after {
  content: '';
  position: absolute;
  top: 1.5px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  transition: left var(--dur-fast) var(--ease-standard);
}

.mode-chip.on {
  color: var(--accent);
}

.mode-chip.on .sw {
  background: var(--accent);
}

.mode-chip.on .sw::after {
  left: 11px;
}

.btns {
  display: flex;
  align-items: center;
  gap: 22px;
}

.side {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 42px;
  padding: 0 16px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
}

.side:disabled {
  opacity: 0.45;
}

.side.danger {
  color: var(--danger);
}

.mic-big {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
}

/* 待机态的主 CTA。**类名不能叫 ready** —— `.ready` 是外层容器的类，
   `flex: 1 + padding` 会连带命中按钮，把 72×72 撑成 72×167 的椭圆（真实的坑）。 */
.mic-big.start {
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: var(--shadow-float);
}

.mic-big.rec {
  background: var(--danger);
  color: var(--on-accent);
  box-shadow: var(--shadow-float);
}

.mic-big.dimmed {
  opacity: 0.4;
}

.kbd-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-caption);
  background: none;
}

.kbd-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.kbd-bar input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  padding-left: 8px;
}

.kb-send {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
}

.kb-send:disabled {
  opacity: 0.5;
}

.kbd-reply {
  width: 100%;
  max-height: 160px;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
  line-height: 1.6;
}

@media (prefers-reduced-motion: reduce) {
  .ready-orb {
    animation: none;
  }

  .wave i,
  .mini-wave i,
  .spin,
  .lv-t b .rec,
  .tl.partial .caret {
    animation: none;
  }

  .vs-enter-active,
  .vs-leave-active {
    transition-duration: 150ms;
  }

  .tl.seek.flash p {
    animation: none;
    background: var(--accent-soft);
  }
}
</style>
