<script setup lang="ts">
/**
 * RingDataPickerSheet — 三环数据源选择面板
 *
 * - 三行（外环/中环/内环），每行可选所有 RingDataSource
 * - 实时预览颜色点
 */
import { computed, ref, watch } from "vue";
import { RING_DATA_LABEL, type RingDataSource } from "@/types/card";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { RING_COLORS } from "@/data/ringDataResolver";

const emit = defineEmits<{ close: [] }>();

const store = useCardLayoutStore();

const RING_SLOT_LABEL = ["外环", "中环", "内环"];

// 本地副本，确认才提交
const local = ref<RingDataSource[]>([...store.rings]);

watch(
  () => store.rings,
  (v) => {
    local.value = [...v];
  },
);

const ALL_SOURCES = Object.keys(RING_DATA_LABEL) as RingDataSource[];

function select(slot: number, src: RingDataSource) {
  // 允许重复，由用户决定
  local.value[slot] = src;
}

function confirm() {
  store.setRings(local.value);
  emit("close");
}

function reset() {
  local.value = ["todo-progress", "steps", "calories"];
}

const previewColors = computed(() =>
  local.value.map((s) => RING_COLORS[s]?.color ?? "var(--bg-300)"),
);
</script>

<template>
  <div class="sheet-mask" @click.self="emit('close')">
    <div class="ring-sheet clean-card">
      <div class="sheet-handle" />
      <div class="sheet-header">
        <h3 class="sheet-title">三环数据</h3>
        <button class="close-btn" @click="emit('close')" aria-label="关闭">
          <i class="bi bi-x-lg" style="font-size:20px"></i>
        </button>
      </div>

      <p class="sheet-desc">点击为每个环选择数据源，可重复</p>

      <!-- 预览三环 -->
      <div class="preview">
        <div class="preview-row" v-for="(src, i) in local" :key="i">
          <span class="dot" :style="{ background: previewColors[i] }" />
          <span class="slot-label">{{ RING_SLOT_LABEL[i] }}</span>
          <span class="src-label">{{ RING_DATA_LABEL[src] }}</span>
        </div>
      </div>

      <!-- 三组选择器 -->
      <div class="slots">
        <div v-for="(src, i) in local" :key="i" class="slot-block">
          <div class="slot-head">
            <span class="dot dot--sm" :style="{ background: previewColors[i] }" />
            <span class="slot-name">{{ RING_SLOT_LABEL[i] }}</span>
          </div>
          <div class="chip-row">
            <button
              v-for="s in ALL_SOURCES"
              :key="s"
              class="chip"
              :class="{ 'chip--active': local[i] === s }"
              @click="select(i, s)"
            >
              {{ RING_DATA_LABEL[s] }}
            </button>
          </div>
        </div>
      </div>

      <div class="footer">
        <button class="btn btn--ghost" @click="reset">恢复默认</button>
        <button class="btn btn--primary" @click="confirm">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.ring-sheet {
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-4) var(--space-5) var(--space-6);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  animation: sheet-up 0.3s var(--ease-out);
  overflow-y: auto;
}

@keyframes sheet-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.sheet-handle {
  width: 40px;
  height: 4px;
  background: var(--bg-300);
  border-radius: var(--radius-full);
  margin: 0 auto var(--space-1);
}

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.sheet-desc {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  margin: 0;
}

.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.preview-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot--sm {
  width: 8px;
  height: 8px;
}

.slot-label {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  width: 40px;
}

.src-label {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.slots {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.slot-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.slot-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.slot-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: all 0.15s;
}

.chip--active {
  background: var(--color-warm);
  border-color: var(--color-warm);
  color: #fff;
  font-weight: var(--fw-semibold);
}

.footer {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.btn {
  flex: 1;
  padding: 12px;
  border-radius: var(--radius-md);
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.btn--ghost {
  background: var(--bg-200);
  color: var(--color-text);
}

.btn--primary {
  background: var(--color-warm);
  color: #fff;
}

.btn:active {
  transform: scale(0.98);
}
</style>
