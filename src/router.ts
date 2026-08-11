import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", name: "chat", component: () => import("./pages/ChatList.vue"), meta: { tab: true } },
    { path: "/chat/:id", name: "chat-detail", component: () => import("./pages/ChatWindow.vue") },
    { path: "/agents", name: "agents", component: () => import("./pages/AgentsPage.vue"), meta: { tab: true } },
    { path: "/models", name: "models", component: () => import("./pages/ModelsPage.vue"), meta: { tab: true } },
    { path: "/settings", name: "settings", component: () => import("./pages/SettingsPage.vue"), meta: { tab: true } },
  ],
});

export default router;
