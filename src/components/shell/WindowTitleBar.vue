<script setup lang="ts">
/**
 * WindowTitleBar — 桌面端自定义窗口标题栏 (Windows / macOS / Linux).
 *
 * 仅在桌面平台渲染，替代 AppTopBar：
 *   左：页面标题（可拖拽区，双击切换最大化）
 *   右：页面注册工具 (useTopBar actions) + 圆形 最小化 / 最大化 / 关闭
 *
 * 依赖 tauri.conf.json 中 decorations:false 隐藏原生标题栏。
 * Web 预览（无 Tauri 运行时）下窗口按钮自动降级为 no-op。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useTopBar } from "@/composables/useTopBar";

const route = useRoute();
const { actions } = useTopBar();

// 页面标题映射（与 AppTopBar 保持一致）
const pageTitle = computed(() => {
  const p = route.path;
  if (p === "/") return "首页";
  if (p.startsWith("/toolbox")) return "百宝箱";
  if (p.startsWith("/sports")) return "运动";
  if (p.startsWith("/workout/history")) return "运动历史";
  if (p.startsWith("/workout")) return "训练";
  if (p.startsWith("/ai")) return "AI";
  if (p.startsWith("/profile")) return "我的";
  if (p.startsWith("/todo")) return "待办";
  if (p.startsWith("/health/water")) return "饮水";
  if (p.startsWith("/health/food")) return "饮食";
  if (p.startsWith("/health/bmi")) return "身体数据";
  if (p.startsWith("/health/weight")) return "体重";
  if (p.startsWith("/health/metrics")) return "健康概览";
  if (p.startsWith("/health")) return "健康";
  return "Rein";
});

// ====== Tauri 窗口控制 ======
type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
};

const win = ref<TauriWindow | null>(null);
const isMaximized = ref(false);
let unlisten: (() => void) | null = null;

async function ensureWin(): Promise<TauriWindow | null> {
  if (win.value) return win.value;
  try {
    const mod = await import("@tauri-apps/api/window");
    const getCurrent = (mod as any).getCurrentWindow ?? (mod as any).getCurrent;
    win.value = getCurrent() as TauriWindow;
    return win.value;
  } catch {
    win.value = null;
    return null;
  }
}

async function refreshMaximized() {
  const w = await ensureWin();
  if (!w) return;
  try {
    isMaximized.value = await w.isMaximized();
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  const w = await ensureWin();
  if (!w) return;
  try {
    unlisten = await w.onResized(() => {
      refreshMaximized();
    });
    await refreshMaximized();
  } catch {
    /* ignore */
  }
});

onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
});

async function minimize() {
  const w = await ensureWin();
  if (!w) return;
  try {
    await w.minimize();
  } catch {
    /* ignore */
  }
}

async function toggleMaximize() {
  const w = await ensureWin();
  if (!w) return;
  try {
    await w.toggleMaximize();
    await refreshMaximized();
  } catch {
    /* ignore */
  }
}

async function close() {
  const w = await ensureWin();
  if (!w) return;
  try {
    await w.close();
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <header class="win-title-bar">
    <!-- 拖拽区：标题 + 弹性空白。按钮簇不在此元素内，避免点击触发拖拽 -->
    <div
      class="win-drag-zone"
      data-tauri-drag-region
      @dblclick="toggleMaximize"
    >
      <span class="win-brand-dot" aria-hidden="true" />
      <h1 class="win-title">{{ pageTitle }}</h1>
    </div>

    <div class="win-actions">
      <!-- 页面注册工具（与 AppTopBar 共用 useTopBar） -->
      <button
        v-for="a in actions"
        :key="a.id"
        class="win-icon-btn"
        :aria-label="a.label"
        :title="a.label"
        @click="a.onClick()"
      >
        <i :class="['bi', `bi-${a.icon}`]" style="font-size: 18px" />
      </button>

      <span v-if="actions.length > 0" class="win-divider" aria-hidden="true" />

      <!-- 窗口控制：最小化 / 最大化 / 关闭 -->
      <button
        class="win-icon-btn win-ctrl"
        aria-label="最小化"
        title="最小化"
        @click="minimize"
      >
        <i class="bi bi-dash-lg" style="font-size: 18px" />
      </button>
      <button
        class="win-icon-btn win-ctrl"
        :aria-label="isMaximized ? '还原' : '最大化'"
        :title="isMaximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <i
          :class="['bi', isMaximized ? 'bi-fullscreen-exit' : 'bi-square']"
          style="font-size: 15px"
        />
      </button>
      <button
        class="win-icon-btn win-ctrl win-ctrl-close"
        aria-label="关闭"
        title="关闭"
        @click="close"
      >
        <i class="bi bi-x-lg" style="font-size: 17px" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.win-title-bar {
  position: sticky;
  top: 0;
  z-index: 50;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  background: var(--material-ultra-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-ultra-thin-blur))
    var(--glass-blur-saturate);
  backdrop-filter: blur(var(--material-ultra-thin-blur))
    var(--glass-blur-saturate);
  border-bottom: 1px solid transparent;
  transition: background var(--dur-halo) var(--ease-immersive),
    border-color var(--dur-halo) var(--ease-immersive);
  user-select: none;
}

/* 拖拽区：填满标题与按钮簇之间的空白，使整栏可拖动 */
.win-drag-zone {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  cursor: default;
}

.win-brand-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--color-primary);
  box-shadow: 0 0 0 3px var(--glow-primary);
  flex-shrink: 0;
}

.win-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  letter-spacing: -0.01em;
  margin: 0;
  line-height: var(--lh-tight);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.win-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.win-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(127, 127, 127, 0.14);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: var(--color-text);
  cursor: pointer;
  padding: 0;
  transition: transform var(--dur-fast) var(--ease-immersive),
    background-color var(--dur-fast) var(--ease-immersive),
    color var(--dur-fast) var(--ease-immersive),
    border-color var(--dur-fast) var(--ease-immersive);
}

.win-icon-btn:hover {
  background: rgba(127, 127, 127, 0.24);
}

.win-icon-btn:active {
  transform: scale(0.9);
}

.win-divider {
  width: 1px;
  height: 18px;
  background: var(--color-divider);
  margin: 0 var(--space-1);
}

.win-ctrl:hover {
  background: rgba(127, 127, 127, 0.3);
}

.win-ctrl-close:hover {
  background: var(--color-danger);
  color: #fff;
  border-color: transparent;
}

:global(.dark) .win-icon-btn {
  border-color: rgba(255, 255, 255, 0.08);
}
</style>
