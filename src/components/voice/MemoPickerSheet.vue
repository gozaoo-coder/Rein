<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import TimeSpine from './TimeSpine.vue'
import { voiceService } from '@/services/voiceService'
import type { VoiceMemo } from '@/types'

/** @纪要 选择器：AI 页输入 @ 时弹出，选中后以 chip 附到消息（发送时注入纪要内容）。
 *  每行给一缕缩略脊 —— 挑引用时，「哪一段」比「标题叫什么」更好认。 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: [memo: VoiceMemo] }>()

const loading = ref(false)
const memos = ref<VoiceMemo[]>([])
const keyword = ref('')

const spineOf = (m: VoiceMemo) =>
  m.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  }))

watch(
  () => props.open,
  (v) => {
    if (v) void load()
  },
)

async function load(): Promise<void> {
  loading.value = true
  try {
    memos.value = await voiceService.memoList(50)
  } catch {
    memos.value = []
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

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
</script>

<template>
  <SheetModal :open="open" title="引用纪要" initial-snap="medium" @close="emit('close')">
    <div class="search">
      <input v-model="keyword" type="text" placeholder="按标题或内容搜索…" @keydown.enter="filtered[0] && emit('pick', filtered[0])">
    </div>
    <p v-if="!loading && filtered.length === 0" class="empty t-3">没有可引用的纪要。</p>
    <ul v-else class="list">
      <li v-for="m in filtered" :key="m.id" class="row" @click="emit('pick', m)">
        <span class="mt">
          <b>{{ m.title || '未命名纪要' }}</b>
          <em>{{ fmtWhen(m.createdAt) }} · {{ m.sentences.length }} 句</em>
          <TimeSpine
            v-if="m.sentences.length"
            class="rowspine"
            size="mini"
            :segments="spineOf(m)"
            :total-ms="m.durationMs"
          />
        </span>
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
  padding: 22px 8px;
  text-align: center;
  font-size: var(--fs-footnote);
}

.list {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-radius: 10px;
  cursor: pointer;
}

.row:active {
  background: var(--surface-2);
}

.row + .row {
  border-top: 0.5px solid var(--line);
}

.ic {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  flex: none;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mt {
  flex: 1;
  min-width: 0;
}

/* 每行一缕缩略脊 */
.rowspine {
  display: block;
  margin-top: 6px;
}

.mt b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mt em {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
</style>
