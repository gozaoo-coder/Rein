<script setup lang="ts">
/**
 * HomeCardRenderer — 按卡片类型分发渲染
 *
 * 接收 CardConfig，渲染对应组件
 */
import type { CardConfig } from "@/types/card";
import ThreeRingCard from "./ThreeRingCard.vue";
import HealthOverviewCard from "./HealthOverviewCard.vue";
import TodayTodoCard from "./TodayTodoCard.vue";
import ImportantTodoCard from "./ImportantTodoCard.vue";
import UrgentTodoCard from "./UrgentTodoCard.vue";
import RecentWorkoutCard from "./RecentWorkoutCard.vue";
import WaterRecordCard from "./WaterRecordCard.vue";
import WaterQuickAddCard from "./WaterQuickAddCard.vue";
import FoodRecordCard from "./FoodRecordCard.vue";

defineProps<{ card: CardConfig }>();
const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <ThreeRingCard v-if="card.type === 'three-ring'" :size="card.size" @click="emit('click')" />
  <HealthOverviewCard v-else-if="card.type === 'health-overview'" :size="card.size" @click="emit('click')" />
  <TodayTodoCard v-else-if="card.type === 'today-todo'" :size="card.size" @click="emit('click')" />
  <ImportantTodoCard v-else-if="card.type === 'important-todo'" :size="card.size" @click="emit('click')" />
  <UrgentTodoCard v-else-if="card.type === 'urgent-todo'" :size="card.size" @click="emit('click')" />
  <RecentWorkoutCard v-else-if="card.type === 'recent-workout'" :size="card.size" @click="emit('click')" />
  <WaterRecordCard v-else-if="card.type === 'water-record'" :size="card.size" @click="emit('click')" />
  <WaterQuickAddCard v-else-if="card.type === 'water-quick-add'" :size="card.size" />
  <FoodRecordCard v-else-if="card.type === 'food-record'" :size="card.size" @click="emit('click')" />
</template>
