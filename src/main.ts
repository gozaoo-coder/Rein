import { createApp } from "vue";
import { createPinia } from "pinia";
import router from "./router";
import App from "./App.vue";

import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles/tokens.css";
import "./styles/global.css";

// Register card components for dynamic :is resolution
import { registerCardComponents } from "@/components/cards/CardRegistry";

// Health cards
import StepsCard from "@/components/cards/health/StepsCard.vue";
import CaloriesCard from "@/components/cards/health/CaloriesCard.vue";
import HeartRateCard from "@/components/cards/health/HeartRateCard.vue";
import SleepCard from "@/components/cards/health/SleepCard.vue";
import WeeklySummaryCard from "@/components/cards/health/WeeklySummaryCard.vue";
import HydrationCard from "@/components/cards/health/HydrationCard.vue";

// Sports cards
import RunningCard from "@/components/cards/sports/RunningCard.vue";
import CyclingCard from "@/components/cards/sports/CyclingCard.vue";
import YogaCard from "@/components/cards/sports/YogaCard.vue";
import StrengthCard from "@/components/cards/sports/StrengthCard.vue";
import MyCoursesCard from "@/components/cards/sports/MyCoursesCard.vue";

registerCardComponents({
  StepsCard,
  CaloriesCard,
  HeartRateCard,
  SleepCard,
  WeeklySummaryCard,
  HydrationCard,
  RunningCard,
  CyclingCard,
  YogaCard,
  StrengthCard,
  MyCoursesCard,
});

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

// 启动时加载持久化数据
// 注意：aiConfigStore / aiChatStore 不在此处加载，避免打包 pi-agent-core / pi-ai SDK（~4MB）。
// AI 相关 store 在首次访问 AI 页面时按需初始化，registerSyncEntity 会在加载时补拉。
import { useCourseStore } from "@/stores/courseStore";
import { useExerciseStore } from "@/stores/exerciseStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useUserStore } from "@/stores/userStore";
import { useTodoStore } from "@/stores/todoStore";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useCardLayoutStore } from "@/stores/cardLayoutStore";
import { usePomodoroStore } from "@/stores/pomodoroStore";
import { initSyncBridge } from "@/composables/useSyncBridge";

const courseStore = useCourseStore(pinia);
const exerciseStore = useExerciseStore(pinia);
const statsStore = useWorkoutStatsStore(pinia);
const userStore = useUserStore(pinia);
const todoStore = useTodoStore(pinia);
const healthStore = useHealthDataStore(pinia);
const cardLayoutStore = useCardLayoutStore(pinia);
const pomodoroStore = usePomodoroStore(pinia);

Promise.all([
  courseStore.load(),
  exerciseStore.load(),
  statsStore.load(),
  userStore.load(),
  todoStore.load(),
  healthStore.load(),
  cardLayoutStore.load(),
  pomodoroStore.load(),
])
  .then(() => initSyncBridge())
  .finally(() => {
    app.mount("#app");
  });

