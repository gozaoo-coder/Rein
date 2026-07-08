<script setup lang="ts">
/**
 * WaterQuickAddCard — 独立的快速记水卡片
 *
 * 与饮水记录卡（WaterRecordCard）不同：本卡只做快速记水，
 * 不显示进度，不跳页。点击数字按钮立即记录该毫升数。
 * 支持 1x1 / 2x1。
 */
import { ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useToast } from "@/composables/useToast";
import type { CardSize } from "@/types/card";

defineProps<{ size: CardSize }>();

const store = useHealthDataStore();
const toast = useToast();

const QUICK_AMOUNTS = [100, 200, 250, 500];
const rippleKey = ref(0);

function quickAdd(ml: number) {
  store.addWater(ml);
  rippleKey.value++;
  toast.success(`+${ml}ml`);
}
</script>

<template>
  <div class="home-card clean-card wqa-card" :class="`home-card--${size}`">
    <div class="wqa-head">
      <span class="title-icon title-icon--blue">
        <i class="bi bi-cup-straw" style="font-size:12px"></i>
      </span>
      <span class="wqa-title">快速记水</span>
    </div>

    <div class="wqa-grid" :class="`wqa-grid--${size}`">
      <button
        v-for="ml in QUICK_AMOUNTS"
        :key="`${ml}-${rippleKey}`"
        class="wqa-btn"
        :class="{ 'wqa-btn--lg': size === '2x1' }"
        @click="quickAdd(ml)"
        :aria-label="`记录${ml}ml`"
      >
        <i class="bi bi-plus-lg wqa-plus"></i>
        <span class="wqa-num">{{ ml }}</span>
        <span class="wqa-unit">ml</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.wqa-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
}

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

.wqa-grid {
  flex: 1;
  display: grid;
  gap: 4px;
  min-height: 0;
}
.wqa-grid--1x1 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}
.wqa-grid--2x1 {
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: 1fr;
}

.wqa-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  border-radius: var(--radius-md);
  border: 1px solid rgba(108, 175, 255, 0.35);
  background: linear-gradient(135deg, rgba(108, 175, 255, 0.12), rgba(108, 175, 255, 0.04));
  color: var(--icon-blue);
  cursor: pointer;
  padding: 2px;
  min-width: 0;
  min-height: 0;
  transition: transform 0.12s var(--ease-immersive), background 0.12s;
}
.wqa-btn:active {
  transform: scale(0.9);
  background: var(--icon-blue);
  color: #fff;
}
.wqa-btn--lg {
  flex-direction: row;
  gap: 2px;
}

.wqa-plus {
  font-size: 9px;
  line-height: 1;
}
.wqa-num {
  font-size: var(--text-sm);
  font-weight: var(--fw-bold);
  line-height: 1.1;
}
.wqa-btn--lg .wqa-num {
  font-size: var(--text-md);
}
.wqa-unit {
  font-size: 8px;
  color: var(--color-text-tertiary);
  line-height: 1;
}
.wqa-btn--lg .wqa-unit {
  font-size: 9px;
}
.wqa-btn:active .wqa-unit {
  color: rgba(255, 255, 255, 0.85);
}
</style>
