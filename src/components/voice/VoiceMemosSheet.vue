<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Play, Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import TimeSpine from './TimeSpine.vue'
import { voiceService } from '@/services/voiceService'
import { useToast } from '@/composables/useToast'
import type { VoiceMemo } from '@/types'

/** 全部纪要抽屉：历史语音纪要列表。
 *  每条不是一行文字，而是**一缕时间脊** —— 一眼看出这段有多长、说到哪、哪几句挂着纪要。 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: [memo: VoiceMemo] }>()

const toast = useToast()
const loading = ref(false)
const memos = ref<VoiceMemo[]>([])
const keyword = ref('')

/** 纪要 → 缩略脊的段落 */
const spineOf = (m: VoiceMemo) =>
  m.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  }))

/** 纪要点挂在句 idx 上，脊按数组位置索引，映射一次 */
const pinsOf = (m: VoiceMemo) => {
  const pos = new Map(m.sentences.map((s, i) => [s.idx, i]))
  return m.summary.flatMap((it) => {
    const ref = it.refs[0]
    const p = ref == null ? undefined : pos.get(ref)
    return p == null
      ? []
      : [{ idx: p, kind: it.kind === 'todo' ? ('todo' as const) : ('answer' as const), text: it.text }]
  })
}

watch(
  () => props.open,
  (v) => {
    if (v) void load()
  },
)

async function load(): Promise<void> {
  loading.value = true
  try {
    memos.value = await voiceService.memoList()
  } catch {
    toast.toast('纪要列表加载失败')
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return memos.value
  return memos.value.filter(
    (m) =>
      m.title.toLowerCase().includes(kw) ||
      m.sentences.some((s) => s.text.toLowerCase().includes(kw)),
  )
})

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function onDelete(m: VoiceMemo): Promise<void> {
  try {
    await voiceService.memoDelete(m.id)
    memos.value = memos.value.filter((x) => x.id !== m.id)
    toast.toast('已删除纪要')
  } catch {
    toast.toast('删除失败')
  }
}
</script>

<template>
  <SheetModal :open="open" title="全部纪要" initial-snap="large" @close="emit('close')">
    <div class="search">
      <input v-model="keyword" type="text" placeholder="搜索标题或内容…">
    </div>
    <p v-if="!loading && filtered.length === 0" class="empty t-3">
      还没有纪要。打开语音对话说一段话，完成后会出现在这里。
    </p>
    <ul v-else class="list">
      <li v-for="m in filtered" :key="m.id" class="row" @click="emit('pick', m)">
        <span class="mt">
          <b>{{ m.title || '未命名纪要' }}</b>
          <em>{{ fmtWhen(m.createdAt) }} · {{ fmtMs(m.durationMs) }} · {{ m.sentences.length }} 句</em>
          <TimeSpine
            v-if="m.sentences.length"
            class="rowspine"
            size="mini"
            :segments="spineOf(m)"
            :total-ms="m.durationMs"
            :pins="pinsOf(m)"
          />
        </span>
        <button class="play" aria-label="打开该纪要" @click.stop="emit('pick', m)"><Play :size="13" /></button>
        <button class="del" aria-label="删除纪要" @click.stop="onDelete(m)">
          <Trash2 :size="14" />
        </button>
      </li>
    </ul>
  </SheetModal>
</template>

<style scoped>
.search {
  padding: 0 2px 8px;
}

.search input {
  width: 100%;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: var(--fs-subhead);
}

.empty {
  padding: 26px 8px;
  text-align: center;
  font-size: var(--fs-footnote);
  line-height: 1.6;
}

.list {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 2px;
  cursor: pointer;
}

.row + .row {
  border-top: 0.5px solid var(--line);
}

.mt {
  flex: 1;
  min-width: 0;
}

/* 每行一缕缩略脊：这是列表的主体视觉，标题只是它的注脚 */
.rowspine {
  display: block;
  margin-top: 7px;
}

.mt b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mt em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
  display: block;
  margin-top: 1px;
}

.play {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: none;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.del {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: none;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
}

.del:active {
  color: var(--danger);
  background: var(--danger-soft);
}
</style>
