<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Mic, Search, Square, Trash2 } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { useTodoStore } from '@/stores/todo'
import { cancelRecording, fmtDur, recorder, startRecording, stopRecording, type RecTake } from '@/system/recorderRuntime'
import { minToHHmm, todayStr } from '@/utils/date'
import type { Todo, TodoAttachment } from '@/types'

/**
 * 录音页（/record）：全局录音的发起端与「未归档 take」的集散地。
 * - 大按钮开始 / 停止 / 取消；录音中可切走，悬浮条接管控制；
 * - take 列表 = 本会话录完但未附加的录音（内存，应用关闭即失）：
 *   回放、删除，或「附加到待办」写入 todos.attachments 持久化。
 */
const store = useTodoStore()
const { toast } = useToast()

onMounted(() => {
  void store.loadAll()
})

const recording = computed(() => recorder.status === 'recording')

async function toggle(): Promise<void> {
  if (recording.value) {
    stopRecording()
    return
  }
  const ok = await startRecording()
  if (!ok) toast(recorder.lastError || '无法开始录音')
}

function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function removeTake(t: RecTake): void {
  const i = recorder.takes.findIndex((x) => x.id === t.id)
  if (i !== -1) recorder.takes.splice(i, 1)
}

/* ---------- 附加到待办 ---------- */

const pickOpen = ref(false)
const pickTarget = ref<RecTake | null>(null)
const query = ref('')
const attaching = ref(false)

function openPick(t: RecTake): void {
  pickTarget.value = t
  query.value = ''
  pickOpen.value = true
}

/** 候选：未完成待办（今天的在前），按标题过滤 */
const candidates = computed(() => {
  const today = todayStr()
  const q = query.value.trim().toLowerCase()
  return store.allTodos
    .filter((t) => t.status !== 'done')
    .filter((t) => !q || t.title.toLowerCase().includes(q))
    .sort((a, b) => (b.date === today ? 1 : 0) - (a.date === today ? 1 : 0) || (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.id - b.id)
    .slice(0, 50)
})

async function attachTo(todo: Todo): Promise<void> {
  const t = pickTarget.value
  if (!t || attaching.value) return
  attaching.value = true
  try {
    const cur = store.allTodos.find((x) => x.id === todo.id)
    if (!cur) {
      toast('待办已不存在')
      return
    }
    const att: TodoAttachment = {
      kind: 'audio',
      name: `录音 ${fmtDur(t.durationSec)}`,
      content: t.dataUrl,
      size: t.size,
      createdAt: t.createdAt,
    }
    await store.update({ ...cur, attachments: [...(cur.attachments ?? []), att] })
    removeTake(t)
    pickOpen.value = false
    toast(`已附加到「${cur.title}」`)
  } finally {
    attaching.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="录音" subtitle="录完可附加到任意待办" back />

    <!-- 录音台 -->
    <section class="card hero" data-testid="record-hero">
      <button
        class="rec-btn"
        :class="{ on: recording }"
        :aria-label="recording ? '停止录音' : '开始录音'"
        data-testid="rec-toggle"
        @click="toggle"
      >
        <Square v-if="recording" :size="30" :stroke-width="2.2" />
        <Mic v-else :size="32" :stroke-width="1.9" />
      </button>
      <p class="num timer" :class="{ live: recording }">{{ fmtDur(recorder.elapsedSec) }}</p>
      <p class="hint t-3">
        {{ recording ? '正在录音 — 可切到别的页面，悬浮条会跟着你' : '点按开始录音' }}
      </p>
      <div v-if="recording" class="row rec-acts">
        <button class="stop" data-testid="rec-stop" @click="stopRecording">
          <Square :size="14" :stroke-width="2.5" /> 停止并保存
        </button>
        <button class="cancel" @click="cancelRecording">取消</button>
      </div>
      <p v-if="recorder.lastError && !recording" class="err">{{ recorder.lastError }}</p>
    </section>

    <!-- 未归档 take -->
    <section class="takes" data-testid="takes">
      <header class="row between thead">
        <b>未归档录音</b>
        <span class="num t-3">{{ recorder.takes.length }}</span>
      </header>
      <p v-if="!recorder.takes.length" class="empty t-3">
        还没有录音。录完的会先留在这里，回放确认后再附加到待办；不附加的关掉应用就没了。
      </p>
      <ul class="tlist">
        <li v-for="t in recorder.takes" :key="t.id" class="card take">
          <div class="row between trow">
            <div class="col tmeta">
              <b class="num">录音 {{ fmtDur(t.durationSec) }}</b>
              <span class="num t-3 sub">{{ hhmm(t.createdAt) }} · {{ fmtSize(t.size) }}</span>
            </div>
            <div class="row tacts">
              <button class="mini primary" :disabled="attaching" @click="openPick(t)">附加到待办</button>
              <button class="tdel" aria-label="删除录音" @click="removeTake(t)">
                <Trash2 :size="15" />
              </button>
            </div>
          </div>
          <audio class="play" controls :src="t.dataUrl" />
        </li>
      </ul>
    </section>

    <!-- 附加目标选择 -->
    <SheetModal :open="pickOpen" title="附加到待办" @close="pickOpen = false">
      <div class="picker">
        <label class="search row">
          <Search :size="15" class="t-3" />
          <input v-model="query" type="text" placeholder="搜索待办标题" aria-label="搜索待办标题">
        </label>
        <ul class="plist">
          <li v-for="t in candidates" :key="t.id">
            <button class="prow row between" @click="attachTo(t)">
              <span class="ptt">{{ t.title }}</span>
              <span class="num t-3 pmeta">
                {{ t.date === todayStr() ? '今天' : (t.date ?? '收件箱') }}{{ t.startMin != null ? ` ${minToHHmm(t.startMin)}` : '' }}
              </span>
            </button>
          </li>
          <li v-if="!candidates.length" class="pempty t-3">没有匹配的未完成待办</li>
        </ul>
      </div>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 录音台 ---------- */

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 26px 16px 22px;
}

.rec-btn {
  position: relative;
  width: 86px;
  height: 86px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--on-accent);
  transition:
    transform var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}

.rec-btn:active {
  transform: scale(0.94);
}

.rec-btn.on {
  background: var(--danger);
}

/* 录音中：外圈呼吸光环（opacity/transform，不触发 layout） */
.rec-btn.on::after {
  content: '';
  position: absolute;
  inset: -7px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--danger) 55%, transparent);
  animation: recpulse 1.6s var(--ease-standard) infinite;
}

@keyframes recpulse {
  0% {
    transform: scale(0.92);
    opacity: 1;
  }
  70%,
  100% {
    transform: scale(1.18);
    opacity: 0;
  }
}

.timer {
  font-size: 40px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.timer.live {
  color: var(--danger);
}

.hint {
  font-size: var(--fs-caption);
}

.rec-acts {
  gap: 10px;
  margin-top: 2px;
}

.stop {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border-radius: var(--radius-full);
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.cancel {
  padding: 9px 16px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: 650;
}

.err {
  font-size: var(--fs-caption);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-radius: var(--radius-s);
  padding: 7px 12px;
}

/* ---------- 未归档 take ---------- */

.takes {
  margin-top: 14px;
}

.thead b {
  font-size: var(--fs-footnote);
}

.empty {
  font-size: var(--fs-caption);
  line-height: 1.6;
  padding: 8px 2px;
}

.tlist {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.take {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.trow {
  gap: 10px;
}

.tmeta {
  gap: 2px;
  min-width: 0;
}

.tmeta b {
  font-size: var(--fs-subhead);
}

.sub {
  font-size: var(--fs-micro);
}

.tacts {
  gap: 8px;
  flex: none;
}

.mini {
  padding: 7px 13px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 700;
}

.mini:disabled {
  opacity: 0.5;
}

.tdel {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-3);
}

.tdel:hover {
  color: var(--danger);
}

.play {
  width: 100%;
  height: 36px;
}

/* ---------- 附加选择 ---------- */

.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.search {
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.search input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.plist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.prow {
  width: 100%;
  gap: 10px;
  padding: 11px 4px;
  border-bottom: 0.5px solid var(--line);
  text-align: left;
}

.ptt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-subhead);
  font-weight: 550;
}

.pmeta {
  flex: none;
  font-size: var(--fs-caption);
}

.pempty {
  padding: 14px 0;
  font-size: var(--fs-caption);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .rec-btn.on::after {
    animation: none;
    opacity: 0;
  }
}
</style>
