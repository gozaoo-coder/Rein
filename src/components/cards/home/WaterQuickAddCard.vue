<script setup lang="ts">
/**
 * WaterQuickAddCard — 快速记水卡片
 *
 * 整张卡片为触发按钮，点击弹出 BottomSheet 记水表单
 * （金额显示 + 预设按钮 + slider + 杯子可视化 + 确认）。
 * 1x1 / 2x1 共用同一个 BottomSheet。
 */
import { computed, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useToast } from "@/composables/useToast";
import { BottomSheet } from "@/components/ui";
import type { CardSize } from "@/types/card";

defineProps<{ size: CardSize }>();

const store = useHealthDataStore();
const toast = useToast();

const todayAmount = computed(() => store.todayWaterAmount);

const showSheet = ref(false);
const addAmount = ref(200);
const PRESET_AMOUNTS = [100, 200, 300, 500];

const sliderPercent = computed(() => Math.min(addAmount.value / 1000, 1) * 100);

function openSheet() {
  addAmount.value = 200;
  showSheet.value = true;
}

function confirmAdd() {
  if (addAmount.value <= 0) return;
  store.addWater(addAmount.value);
  showSheet.value = false;
  toast.success(`+${addAmount.value}ml`);
}

function onSliderInput(e: Event) {
  addAmount.value = Number((e.target as HTMLInputElement).value);
}
</script>

<template>
  <button
    type="button"
    class="home-card clean-card wqa-card"
    :class="`home-card--${size}`"
    @click="openSheet"
  >
    <div class="wqa-head">
      <span class="title-icon title-icon--blue">
        <i class="bi bi-cup-straw" style="font-size:12px"></i>
      </span>
      <span class="wqa-title">快速记水</span>
    </div>

    <div class="wqa-body" :class="`wqa-body--${size}`">
      <i class="bi bi-droplet-fill wqa-drop"></i>
      <div class="wqa-amount-row">
        <span class="wqa-amount">{{ todayAmount }}</span>
        <span class="wqa-unit">ml</span>
      </div>
    </div>

    <div class="wqa-hint">
      <i class="bi bi-plus-lg"></i>
    </div>
  </button>

  <BottomSheet
    v-model:visible="showSheet"
    title="记一次饮水"
    :detents="['medium']"
    default-detent="medium"
  >
    <div class="add-body">
      <div class="amount-display">
        <span class="amount-num">{{ addAmount }}</span>
        <span class="amount-unit">ml</span>
      </div>

      <div class="preset-row">
        <button
          v-for="a in PRESET_AMOUNTS"
          :key="a"
          class="preset-btn"
          :class="{ active: addAmount === a }"
          @click="addAmount = a"
        >
          {{ a }}ml
        </button>
      </div>

      <div class="slider-wrap">
        <input
          type="range"
          min="0"
          max="1000"
          step="10"
          :value="addAmount"
          class="water-slider"
          :style="{ '--slider-percent': sliderPercent + '%' }"
          @input="onSliderInput"
        />
        <div class="slider-scale">
          <span>0</span><span>250</span><span>500</span><span>750</span><span>1000ml</span>
        </div>
      </div>

      <div class="cup-visual">
        <div class="cup-fill" :style="{ height: sliderPercent + '%' }">
          <div class="cup-wave" />
        </div>
      </div>

      <button class="confirm-btn" @click="confirmAdd" :disabled="addAmount <= 0">
        记 {{ addAmount }}ml
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.wqa-card {
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
.wqa-card:active { transform: scale(0.98); }
.wqa-card:hover { box-shadow: var(--shadow-card-hover); }

.wqa-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
  background: var(--icon-blue);
}

.wqa-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.wqa-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 0;
}
.wqa-body--1x1 {
  flex-direction: column;
  gap: 2px;
}
.wqa-body--2x1 {
  flex-direction: row;
  gap: var(--space-2);
}

.wqa-drop {
  font-size: 18px;
  color: var(--icon-blue);
  line-height: 1;
}

.wqa-amount-row {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.wqa-amount {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--icon-blue);
  line-height: 1;
}
.wqa-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.wqa-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
  font-size: 10px;
  line-height: 1;
}

/* BottomSheet 表单 */
.add-body {
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
  color: #3da9ff;
  line-height: 1;
}
.amount-unit {
  font-size: var(--text-lg);
  color: var(--color-text-tertiary);
}

.preset-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: center;
}
.preset-btn {
  padding: 8px 16px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.preset-btn.active {
  border-color: #3da9ff;
  background: rgba(61, 169, 255, 0.1);
  color: #3da9ff;
}

.slider-wrap {
  width: 100%;
  padding: 0 var(--space-2);
}
.water-slider {
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: linear-gradient(to right, #3da9ff 0%, #3da9ff var(--slider-percent, 0%), var(--bg-200) var(--slider-percent, 0%), var(--bg-200) 100%);
  border-radius: var(--radius-full);
  outline: none;
}
.water-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid #3da9ff;
  box-shadow: var(--shadow-md);
  cursor: pointer;
}
.water-slider::-moz-range-thumb {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid #3da9ff;
  box-shadow: var(--shadow-md);
  cursor: pointer;
}
.slider-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.cup-visual {
  width: 80px;
  height: 100px;
  border: 2px solid #b3dfff;
  border-top: none;
  border-radius: 0 0 40px 40px;
  position: relative;
  overflow: hidden;
  background: var(--bg-100);
}
.cup-fill {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(180deg, #7dc8ff 0%, #3da9ff 100%);
  transition: height 0.2s;
  border-radius: 0 0 38px 38px;
  overflow: hidden;
}
.cup-wave {
  position: absolute;
  top: -6px;
  left: -10%;
  width: 120%;
  height: 12px;
  background: radial-gradient(ellipse at center, transparent 0%, transparent 50%, #7dc8ff 50%);
  background-size: 20px 12px;
  animation: wave 2s linear infinite;
}
@keyframes wave {
  from { transform: translateX(0); }
  to { transform: translateX(-20px); }
}

.confirm-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: #3da9ff;
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
  margin-top: var(--space-2);
}
.confirm-btn:active { transform: scale(0.98); }
.confirm-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}
</style>
