<script setup lang="ts">
import { computed, provide, ref } from "vue";
import { useRoute } from "vue-router";
import TabBar from "./components/TabBar.vue";
import Rail from "./components/Rail.vue";
import ChatList from "./pages/ChatList.vue";
import ChatWindow from "./pages/ChatWindow.vue";
import { useBreakpoint } from "./composables/useBreakpoint";

const route = useRoute();
const isWide = useBreakpoint();

const showTabBar = computed(() => !!route.meta.tab && !isWide.value);
const isChatRoute = computed(() => route.name === "chat" || route.name === "chat-detail");
const isChatDetail = computed(() => route.name === "chat-detail");
const isChatList = computed(() => route.name === "chat");

const toast = ref<{ text: string; key: number } | null>(null);
let toastTimer: number | undefined;
function showToast(text: string, duration = 2200) {
  toast.value = { text, key: Date.now() };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), duration);
}
provide("toast", showToast);
</script>

<template>
  <!-- 窄窗：手机式 -->
  <div v-if="!isWide" class="app-shell">
    <router-view v-slot="{ Component }">
      <transition name="page-slide">
        <component :is="Component" :key="route.fullPath" />
      </transition>
    </router-view>
    <TabBar v-if="showTabBar" />
    <div v-if="toast" :key="toast.key" class="toast">{{ toast.text }}</div>
  </div>

  <!-- 宽窗：桌面双栏 -->
  <div v-else class="desktop-shell">
    <Rail />
    <ChatList v-if="isChatRoute" />
    <router-view v-else v-slot="{ Component }">
      <div class="desktop-page">
        <component :is="Component" :key="route.fullPath" />
      </div>
    </router-view>
    <ChatWindow v-if="isChatDetail" />
    <div v-if="toast" :key="toast.key" class="toast">{{ toast.text }}</div>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}
.app-shell > :first-child {
  flex: 1;
  min-height: 0;
}

.desktop-shell {
  height: 100%;
  display: flex;
  background: #f5f5f5;
  position: relative;
}
.desktop-page {
  flex: 1;
  min-width: 0;
  background: #f5f5f5;
}

.page-slide-enter-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.page-slide-enter-from {
  opacity: 0;
  transform: translateX(14px);
}
</style>
