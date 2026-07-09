<script setup lang="ts">
/**
 * TodoQuickAddCard — 快速新建待办
 *
 * 整张卡片为触发按钮，点击跳转到待办页并自动打开新建 BottomSheet
 * （通过 ?new=1 query 触发 TodoPage.openCreate，复用同一套编辑器）。
 * 仅允许 1x1 / 1x2 / 2x1 / 2x2。
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const router = useRouter();

const isVertical = computed(() => props.size === "1x1" || props.size === "1x2");

function openCreate() {
  router.push("/todo?new=1");
}
</script>

<template>
  <button
    type="button"
    class="home-card clean-card tq-card"
    :class="[`home-card--${size}`, { 'tq-card--vertical': isVertical }]"
    @click="openCreate"
  >
    <div class="tq-inner">
      <div class="tq-icon-circle">
        <i class="bi bi-plus-lg" />
      </div>
      <div class="tq-text">
        <div class="tq-title">新建待办</div>
        <div class="tq-sub" v-if="size !== '1x1'">点按快速记录</div>
      </div>
    </div>
  </button>
</template>

<style scoped>
.tq-card {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  border: none;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.tq-card:active { transform: scale(0.97); }
.tq-card:hover { box-shadow: var(--shadow-card-hover); }

.tq-inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tq-card--vertical .tq-inner {
  flex-direction: column;
  gap: var(--space-1);
}

.tq-icon-circle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--icon-orange) 0%, var(--warning-500) 100%);
  color: #fff;
  font-size: 20px;
  line-height: 1;
  box-shadow: var(--shadow-sm);
}

.tq-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tq-card--vertical .tq-text {
  align-items: center;
  text-align: center;
}

.tq-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text-primary);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tq-sub {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  line-height: 1;
  white-space: nowrap;
}
</style>
