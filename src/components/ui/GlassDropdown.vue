<script setup lang="ts">
/**
 * GlassDropdown — Thick-tier frosted popover menu.
 * HarmonyOS 沉浸光感 spec: translucent rounded panel with blurred backdrop,
 * list of menu items (optional check marks, icons, destructive state).
 * Closes on outside click and Escape.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

export interface DropdownItem {
  key: string;
  label: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    items: DropdownItem[];
    align?: "left" | "right" | "center";
    width?: number;
  }>(),
  {
    align: "right",
    width: 200,
  }
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  select: [key: string];
}>();

const panelRef = ref<HTMLDivElement | null>(null);

function close() {
  emit("update:open", false);
}

function onItemClick(item: DropdownItem) {
  if (item.disabled) return;
  emit("select", item.key);
  close();
}

function onDocClick(e: MouseEvent) {
  if (!props.open) return;
  const el = panelRef.value;
  if (el && !el.contains(e.target as Node)) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && props.open) close();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocClick);
  document.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocClick);
  document.removeEventListener("keydown", onKey);
});

const panelStyle = computed(() => ({
  width: `${props.width}px`,
}));
</script>

<template>
  <Teleport to="body">
    <Transition name="dropdown">
      <div
        v-if="open"
        ref="panelRef"
        class="glass-dropdown"
        :class="[`dropdown--${align}`]"
        :style="panelStyle"
        role="menu"
      >
        <button
          v-for="item in items"
          :key="item.key"
          class="dropdown-item"
          :class="{
            'is-checked': item.checked,
            'is-disabled': item.disabled,
            'is-destructive': item.destructive,
          }"
          role="menuitem"
          :disabled="item.disabled"
          @click="onItemClick(item)"
        >
          <span class="item-label">{{ item.label }}</span>
          <i
            v-if="item.checked"
            class="bi bi-check-lg item-check"
            style="font-size:16px"
          ></i>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.glass-dropdown {
  position: fixed;
  z-index: 200;
  padding: var(--space-2);
  border-radius: var(--radius-popover);
  background: var(--material-thick-bg);
  -webkit-backdrop-filter: blur(var(--material-thick-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-thick-blur)) saturate(180%);
  border: 1px solid var(--material-thick-border);
  box-shadow: var(--material-thick-shadow);
  max-height: min(420px, 80vh);
  overflow-y: auto;
  overflow-x: hidden;
}

.dropdown--right {
  top: calc(env(safe-area-inset-top, 0px) + 56px);
  right: var(--space-4);
}

.dropdown--left {
  top: calc(env(safe-area-inset-top, 0px) + 56px);
  left: var(--space-4);
}

.dropdown--center {
  top: calc(env(safe-area-inset-top, 0px) + 56px);
  left: 50%;
  transform: translateX(-50%);
}

.dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-3);
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-immersive);
  box-sizing: border-box;
  font-family: inherit;
}

.dropdown-item:active {
  background: rgba(0, 0, 0, 0.06);
}

.dropdown-item.is-disabled {
  opacity: 0.4;
  pointer-events: none;
}

.dropdown-item.is-destructive {
  color: var(--color-danger);
}

.item-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-check {
  flex-shrink: 0;
  color: var(--color-primary);
}

/* Transition */
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.dropdown--center.dropdown-enter-from,
.dropdown--center.dropdown-leave-to {
  transform: translateX(-50%) translateY(-8px) scale(0.96);
}
</style>
