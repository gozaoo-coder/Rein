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
      path: "/ai",
      name: "ai",
      component: () => import("@/pages/AIPage.vue"),
    },
    {
      path: "/devices",
      name: "devices",
      component: () => import("@/pages/DevicesPage.vue"),
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
