<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const tabs = [
  { name: "chat", label: "聊天", icon: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" },
  { name: "agents", label: "智能体", icon: "M4 8h16v12H4z M12 4v4 M9 13h.01 M15 13h.01 M9 17h6" },
  { name: "models", label: "模型配置", icon: "M6 6h12v12H6z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4" },
  { name: "settings", label: "程序设置", icon: "M12 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" },
];

const activeName = computed(() => {
  if (route.name === "chat-detail") return "chat";
  return String(route.name ?? "chat");
});

function go(name: string) {
  router.push({ name });
}
</script>

<template>
  <nav class="rail">
    <button class="rail-logo" title="Rein">
      <span>R</span>
    </button>
    <div class="rail-tabs">
      <button
        v-for="t in tabs"
        :key="t.name"
        class="rail-tab"
        :class="{ on: activeName === t.name }"
        :title="t.label"
        @click="go(t.name)"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path :d="t.icon" /></svg>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  flex: none;
  width: 56px;
  background: #e7e7e7;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 18px;
  border-right: 1px solid #d8d8d8;
}
.rail-logo {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background: linear-gradient(135deg, #07c160, #05a853);
  color: #fff;
  font-size: 19px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s;
}
.rail-logo:hover {
  transform: scale(1.06);
}
.rail-logo:active {
  transform: scale(0.94);
}
.rail-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rail-tab {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8a8a8a;
  transition: all 0.15s;
}
.rail-tab:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #191919;
}
.rail-tab:active {
  transform: scale(0.92);
}
.rail-tab.on {
  background: #fff;
  color: #07c160;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
</style>
