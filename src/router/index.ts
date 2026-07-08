import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("@/pages/HealthPage.vue"),
    },
    {
      path: "/sports",
      name: "sports",
      component: () => import("@/pages/SportsPage.vue"),
    },
    {
      path: "/sports/courses",
      name: "courses-all",
      component: () => import("@/pages/CourseListPage.vue"),
    },
    {
      path: "/sports/courses/:id",
      name: "course-detail",
      component: () => import("@/pages/CourseEditPage.vue"),
    },
    {
      path: "/sports/exercises",
      name: "exercises",
      component: () => import("@/pages/ExerciseLibraryPage.vue"),
    },
    {
      path: "/sports/exercises/new",
      name: "exercise-new",
      component: () => import("@/pages/ExerciseEditPage.vue"),
    },
    {
      path: "/sports/exercises/:id",
      name: "exercise-edit",
      component: () => import("@/pages/ExerciseEditPage.vue"),
    },
    {
      path: "/ai",
      name: "ai",
      component: () => import("@/pages/AIPage.vue"),
    },
    {
      path: "/ai/config",
      name: "ai-config",
      component: () => import("@/pages/AiConfigPage.vue"),
    },
    {
      path: "/ai/history",
      name: "ai-history",
      component: () => import("@/pages/AiHistoryPage.vue"),
    },
    {
      path: "/profile",
      name: "profile",
      component: () => import("@/pages/ProfilePage.vue"),
    },
    {
      path: "/workout",
      name: "workout",
      component: () => import("@/pages/WorkoutPage.vue"),
    },
    {
      path: "/workout/history/:id",
      name: "workout-history-detail",
      component: () => import("@/pages/WorkoutHistoryDetailPage.vue"),
    },
    {
      path: "/todo",
      name: "todo",
      component: () => import("@/pages/TodoPage.vue"),
    },
    {
      path: "/health/water",
      name: "health-water",
      component: () => import("@/pages/WaterPage.vue"),
    },
    {
      path: "/health/food",
      name: "health-food",
      component: () => import("@/pages/FoodPage.vue"),
    },
    {
      path: "/health/food-db",
      name: "health-food-db",
      component: () => import("@/pages/FoodDatabasePage.vue"),
    },
    {
      path: "/health/bmi",
      name: "health-bmi",
      component: () => import("@/pages/BodyMetricsPage.vue"),
    },
    {
      path: "/health/metrics",
      name: "health-metrics",
      component: () => import("@/pages/HealthOverviewPage.vue"),
    },
    {
      path: "/sync",
      name: "sync",
      component: () => import("@/pages/SyncPage.vue"),
    },
  ],
});

export default router;
