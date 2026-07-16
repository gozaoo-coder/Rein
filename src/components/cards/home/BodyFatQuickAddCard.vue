<script setup lang="ts">
/**
 * BodyFatQuickAddCard — 快速记体脂卡片
 *
 * 整张卡片为触发按钮，点击弹出 BottomSheet 记录体脂率
 * （当前值显示 + 预设按钮 + 数字输入 + 确认）。
 * 1x1 / 1x2 / 2x1 共用同一个 BottomSheet。
 */
import { computed, ref, onMounted } from "vue";
import { useAnime } from "@/composables/useAnime";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useToast } from "@/composables/useToast";
import { BottomSheet } from "@/components/ui";
import type { CardSize } from "@/types/card";

defineProps<{ size: CardSize }>();

const store = useHealthDataStore();
const toast = useToast();

const currentFat = computed<number | undefined>(
  () => store.latestBodyMetrics?.bodyFatPercent,
);

const fatText = computed(() =>
  currentFat.value != null ? currentFat.value.toFixed(1) : "--",
);

const { animate, reduced } = useAnime();
const display = ref("--");

onMounted(() => {
  if (currentFat.value == null) { display.value = "--"; return; }
  if (reduced.value) { display.value = currentFat.value.toFixed(1); return; }
  const obj = { val: 0 };
  animate(obj, {
    val: currentFat.value,
    duration: 800,
    ease: "outExpo",
    onUpdate: () => { display.value = obj.val.toFixed(1); },
  });
});

const showSheet = ref(false);
const fatInput = ref<string>("");
const PRESET_FATS = [15, 18, 20, 22, 25, 28, 30, 33];

function openSheet() {
  fatInput.value = currentFat.value != null ? currentFat.value.toFixed(1) : "";
  showSheet.value = true;
}

function setPreset(v: number) {
  fatInput.value = String(v);
}

function confirmRecord() {
  const pct = Number(fatInput.value);
  if (!fatInput.value || Number.isNaN(pct) || pct <= 0 || pct >= 100) return;
  store.addBodyMetrics({ bodyFatPercent: pct });
  showSheet.value = false;
  toast.success(`已记录 ${pct.toFixed(1)}%`);
}

const isValid = computed(() => {
  const v = Number(fatInput.value);
  return !!fatInput.value && !Number.isNaN(v) && v > 0 && v < 100;
});
</script>

<template>
  <button
    type="button"
    class="home-card clean-card bfq-card"
    :class="`home-card--${size}`"
    @click="openSheet"
  >
    <div class="bfq-body" :class="`bfq-body--${size}`">
      <span class="bfq-icon-circle" :class="`bfq-icon-circle--${size}`">
        <i class="bi bi-person-fill"></i>
      </span>
      <div class="bfq-amount-row" :class="`bfq-amount-row--${size}`">
        <span class="bfq-amount">{{ display }}</span>
        <span class="bfq-unit">%</span>
      </div>
    </div>

    <div class="bfq-hint" v-if="size !== '1x1'">
      <i class="bi bi-plus-lg"></i>
      <span class="bfq-hint-text">记体脂</span>
    </div>
  </button>

  <BottomSheet
    v-model:visible="showSheet"
    title="记体脂率"
    :detents="['medium']"
    default-detent="medium"
  >
    <div class="sheet-body">
      <div class="amount-display">
        <span class="amount-num">{{ fatInput || "--" }}</span>
        <span class="amount-unit">%</span>
      </div>

      <div class="input-wrap">
        <input
          v-model="fatInput"
          type="number"
          step="0.1"
          min="0"
          max="100"
          inputmode="decimal"
          placeholder="如 22.0"
          class="fat-input"
        />
        <span class="input-unit">%</span>
      </div>

      <div class="preset-row">
        <button
          v-for="p in PRESET_FATS"
          :key="p"
          class="preset-btn"
          :class="{ active: fatInput === String(p) }"
          @click="setPreset(p)"
        >
          {{ p }}%
        </button>
      </div>

      <button class="confirm-btn" :disabled="!isValid" @click="confirmRecord">
        记录
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.bfq-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: none;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.bfq-card:active { transform: scale(0.98); }
.bfq-card:hover { box-shadow: var(--shadow-card-hover); }

.bfq-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 0;
}
.bfq-body--1x1 {
  flex-direction: column;
  gap: 2px;
}
.bfq-body--1x2 {
  flex-direction: column;
  gap: var(--space-1);
}
.bfq-body--2x1 {
  flex-direction: row;
  gap: var(--space-2);
}

.bfq-icon-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
  background: var(--icon-purple);
  line-height: 1;
}
.bfq-icon-circle--1x1 {
  width: 22px;
  height: 22px;
  font-size: 12px;
}
.bfq-icon-circle--1x2 {
  width: 28px;
  height: 28px;
  font-size: 14px;
}
.bfq-icon-circle--2x1 {
  width: 28px;
  height: 28px;
  font-size: 14px;
}

.bfq-amount-row {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.bfq-amount-row--1x1 {
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.bfq-amount-row--1x2 {
  flex-direction: column;
  align-items: center;
  gap: 0;
}

.bfq-amount {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--icon-purple);
  line-height: 1;
}
.bfq-body--1x1 .bfq-amount {
  font-size: var(--text-lg);
}

.bfq-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

.bfq-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--color-text-tertiary);
  font-size: 10px;
  line-height: 1;
}
.bfq-hint-text {
  font-weight: var(--fw-semibold);
}

/* BottomSheet 表单 */
.sheet-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) 0;
}

.amount-display {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.amount-num {
  font-size: 56px;
  font-weight: var(--fw-bold);
  color: var(--icon-purple);
  line-height: 1;
}
.amount-unit {
  font-size: var(--text-lg);
  color: var(--color-text-tertiary);
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: var(--bg-100);
  box-sizing: border-box;
}
.input-wrap:focus-within {
  border-color: var(--icon-purple);
  background: var(--bg-50);
}

.fat-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  -moz-appearance: textfield;
}
.fat-input::-webkit-outer-spin-button,
.fat-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.input-unit {
  font-size: var(--text-md);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

.preset-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: center;
}
.preset-btn {
  padding: 8px 14px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.preset-btn.active {
  border-color: var(--icon-purple);
  background: rgba(124, 108, 247, 0.1);
  color: var(--icon-purple);
}

.confirm-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--icon-purple);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
}
.confirm-btn:active { transform: scale(0.98); }
.confirm-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}
</style>
