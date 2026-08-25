<script setup lang="ts">
import { ref, watch } from 'vue'
import { Archive } from 'lucide-vue-next'

import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER, suggestMeal } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { useAiStore } from '@/stores/ai'
import { removeFoodDraft, saveFoodDraft, updateFoodDraftItems, type FoodDraft } from '@/utils/foodDrafts'
import type { MealType, ParsedFoodItem } from '@/types'

/**
 * 食物草稿编辑弹层：打开草稿箱条目 → 可编辑解析卡（改重量 / 删行 / 单位换算）
 * → 写入今日饮食或覆盖回草稿。拍照识别已改为走聊天流（AIPage 附件 → 模型看图出卡），
 * 本组件只服务草稿箱入口。
 */
const emit = defineEmits<{ committed: []; savedDraft: [] }>()

const ai = useAiStore()
const toast = useToast()

const open = ref(false)
const thumb = ref<string | null>(null)
const items = ref<ParsedFoodItem[]>([])
const meal = ref<MealType>(suggestMeal())
const stats = ref({ totalKcal: 0, total: 0, matched: 0 })
/** 正在编辑的草稿 id：条目变化自动回写，写入成功后删除草稿 */
const draftId = ref<string | null>(null)

defineExpose({ openDraft })

function reset(): void {
  thumb.value = null
  items.value = []
  draftId.value = null
  meal.value = suggestMeal()
  stats.value = { totalKcal: 0, total: 0, matched: 0 }
}

/** 草稿箱入口：直接进入编辑态 */
function openDraft(d: FoodDraft): void {
  reset()
  thumb.value = d.thumbBase64 ?? null
  items.value = d.items
  draftId.value = d.id
  open.value = true
}

/* 草稿态下的编辑实时回写 */
watch(
  () => items.value.map((it) => `${it.foodName}:${it.grams}:${it.foodId ?? '-'}`).join('|'),
  () => {
    if (draftId.value && open.value) updateFoodDraftItems(draftId.value, items.value)
  },
)

function saveDraft(): void {
  if (items.value.length === 0) return
  saveFoodDraft({ thumbBase64: thumb.value ?? undefined, items: items.value })
  draftId.value = null
  toast.toast('已存入草稿箱')
  emit('savedDraft')
  close()
}

async function commit(): Promise<void> {
  const r = await ai.commitParsedItems(items.value, meal.value, 'photo_ai')
  if (r.written === 0) {
    toast.toast('没有可写入的食物（全部未匹配食物库）')
    return
  }
  const skipped = items.value.length - r.written
  toast.toast(
    skipped > 0
      ? `已写入 ${r.written} 项，跳过 ${skipped} 项未匹配`
      : `已写入 ${r.written} 项到今日${MEAL_LABELS[meal.value]}`,
  )
  if (draftId.value) removeFoodDraft(draftId.value)
  emit('committed')
  close()
}

function close(): void {
  open.value = false
}
</script>

<template>
  <SheetModal :open="open" title="编辑食物草稿" initial-snap="large" @close="close">
    <div class="ready">
      <div class="sum row">
        <img v-if="thumb" :src="`data:image/jpeg;base64,${thumb}`" alt="照片缩略图" class="mini">
        <p class="flex-1">
          识别到 {{ stats.total }} 项 · ≈{{ stats.totalKcal }} 大卡<span v-if="stats.matched < stats.total">
            （{{ stats.matched }} 项可写入）</span>
        </p>
      </div>

      <FoodParseEditor v-model="items" @change="stats = $event" />

      <SegmentedControl
        v-model:model-value="meal"
        class="meal"
        :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
      />

      <div class="acts row between">
        <button class="ghost row center" :disabled="!items.length" @click="saveDraft">
          <Archive :size="15" /> 存草稿箱
        </button>
        <button class="primary" :disabled="stats.matched === 0" @click="commit">
          写入今日{{ MEAL_LABELS[meal] }}
        </button>
      </div>
      <p v-if="stats.matched === 0" class="hint">所有条目都未匹配到食物库，无法写入；可存草稿稍后处理。</p>
    </div>
  </SheetModal>
</template>

<style scoped>
.sum {
  gap: 10px;
  margin-bottom: 8px;
}

.sum p {
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.mini {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: var(--radius-m);
  object-fit: cover;
  background: var(--surface-2);
}

.meal {
  margin-top: 12px;
}

.acts {
  gap: 10px;
  margin-top: 14px;
}

.ghost {
  gap: 5px;
  padding: 11px 14px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.ghost:disabled {
  opacity: 0.4;
}

.primary {
  padding: 11px 22px;
  border-radius: var(--radius-full);
  background: var(--ok);
  color: #fff;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.primary:disabled {
  opacity: 0.35;
}

.hint {
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  text-align: center;
}
</style>
