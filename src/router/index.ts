import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "health",
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
  ],
});

export default router;
