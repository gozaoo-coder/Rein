<script lang="ts">
import type { Component } from 'vue'

/** 菜单项：icon 缺省为纯文字样式；children 生成下一级层叠面板（bind）或内嵌分组（dialog） */
export interface MenuItem {
  label: string
  value: string
  icon?: Component
  danger?: boolean
  disabled?: boolean
  children?: MenuItem[]
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

/**
 * AppMenu 统一菜单：bind（锚定触发组件旁弹出，默认）与 dialog（底部操作面板）两种出现方式。
 * bind 型 Teleport 到 body 定位，不受父容器 overflow 裁剪；z-index 114+，高于 SheetModal(100)、低于 Toast(120)。
 * 多级层叠：点击带 children 的项推入下一层面板，再点同项或点遮罩收起。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    actions: MenuItem[]
    /** 出现方式：bind = 锚定 anchor 元素旁；dialog = 底部操作面板。默认 bind */
    mode?: 'bind' | 'dialog'
    /** bind 模式的锚定元素（触发菜单的按钮/元素） */
    anchor?: HTMLElement | null
    title?: string
  }>(),
  { mode: 'bind', anchor: null, title: undefined },
)

const emit = defineEmits<{
  close: []
  select: [value: string]
}>()

const bindMode = computed(() => props.mode === 'bind' && props.anchor !== null)

/** 关闭时保留 levels 供离场动画播放，仅停止渲染 */
const visibleLevels = computed(() => (props.open ? levels.value : []))

/* ---------- bind 模式：多级层叠面板 ---------- */

interface MenuLevel {
  items: MenuItem[]
  /** 触发本层的锚定矩形（根层为 anchor 元素，子层为所点菜单项） */
  anchorRect: DOMRect | null
  /** 已打开层来自哪个父项 value，用于再次点击收起 */
  openedFrom?: string
  /** 测量后写入的定位样式；null 表示未测量（先隐藏渲染） */
  style: Record<string, string> | null
}

const levels = ref<MenuLevel[]>([])
const panelEls = new Map<number, HTMLElement>()

function setPanel(i: number, el: unknown): void {
  if (el instanceof HTMLElement) panelEls.set(i, el)
  else panelEls.delete(i)
}

const GAP = 6
const EDGE = 8

/** 测量各层面板尺寸并定位：优先锚点下方，空间不足翻到上方；水平越界则右对齐/钳制在视口内 */
async function layout(): Promise<void> {
  await nextTick()
  levels.value.forEach((lv, i) => {
    const el = panelEls.get(i)
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const rect = lv.anchorRect
    if (!rect) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top: number
    let originY: string
    if (i === 0) {
      // 根层：优先锚点下方，空间不足翻到上方，再不行钳制在视口内
      if (h + GAP <= vh - rect.bottom - EDGE) {
        top = rect.bottom + GAP
        originY = 'top'
      } else if (h + GAP <= rect.top - EDGE) {
        top = rect.top - GAP - h
        originY = 'bottom'
      } else {
        top = Math.min(Math.max(EDGE, rect.bottom + GAP), vh - EDGE - h)
        originY = 'top'
      }
    } else {
      // 子层：与父项顶对齐（经典层叠），底部放不下整体上移
      top = rect.top
      originY = 'top'
      if (top + h > vh - EDGE) {
        top = vh - EDGE - h
        originY = 'bottom'
      }
      if (top < EDGE) top = EDGE
    }
    let left: number
    let originX = 'left'
    if (i === 0) {
      left = rect.left
      if (left + w > vw - EDGE) {
        left = rect.right - w
        originX = 'right'
      }
      if (left < EDGE) {
        left = EDGE
        originX = 'left'
      }
    } else {
      // 子层默认向右层叠，右侧放不下翻到左侧
      if (rect.right + GAP + w <= vw - EDGE) {
        left = rect.right + GAP
        originX = 'left'
      } else {
        left = rect.left - GAP - w
        originX = 'right'
      }
    }
    lv.style = {
      position: 'fixed',
      top: `${Math.round(top)}px`,
      left: `${Math.round(Math.max(EDGE, Math.min(left, vw - EDGE - w)))}px`,
      zIndex: `${115 + i}`,
      transformOrigin: `${originX} ${originY}`,
    }
  })
}

function onItemClick(a: MenuItem, e: MouseEvent, levelIdx: number): void {
  if (a.disabled) return
  if (a.children?.length) {
    const next = levels.value[levelIdx + 1]
    if (next && next.openedFrom === a.value) {
      levels.value = levels.value.slice(0, levelIdx + 1)
    } else {
      levels.value = levels.value.slice(0, levelIdx + 1)
      levels.value.push({
        items: a.children,
        anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
        openedFrom: a.value,
        style: null,
      })
    }
    void layout()
    return
  }
  emit('select', a.value)
  emit('close')
}

function closeAll(): void {
  emit('close')
}

function onViewportChange(): void {
  // 视口变化后锚定位置不可信，直接收起，行为可预期
  if (props.open && bindMode.value) closeAll()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) closeAll()
}

watch(
  () => props.open,
  (open) => {
    if (open && bindMode.value) {
      levels.value = [
        {
          items: props.actions,
          anchorRect: props.anchor!.getBoundingClientRect(),
          style: null,
        },
      ]
      void layout()
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('keydown', onKeydown)
    }
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('keydown', onKeydown)
})

/* ---------- dialog 模式：层级拍平为缩进分组 ---------- */

const flatActions = computed(() => {
  const out: { item: MenuItem; depth: number; header: boolean }[] = []
  const walk = (items: MenuItem[], depth: number): void => {
    for (const it of items) {
      if (it.children?.length) {
        out.push({ item: it, depth, header: true })
        walk(it.children, depth + 1)
      } else {
        out.push({ item: it, depth, header: false })
      }
    }
  }
  walk(props.actions, 0)
  return out
})
</script>

<template>
  <Teleport to="body">
    <!-- bind：透明点击层（无视觉遮罩）+ 锚定面板 -->
    <template v-if="bindMode">
      <div v-if="open" class="catcher" @click="closeAll" @contextmenu.prevent="closeAll" />
      <TransitionGroup name="am-pop">
        <div
          v-for="(lv, i) in visibleLevels"
          :key="i"
          :ref="(el) => setPanel(i, el)"
          class="panel"
          :style="lv.style ?? undefined"
          role="menu"
        >
          <p v-if="i === 0 && title" class="ptitle">{{ title }}</p>
          <button
            v-for="a in lv.items"
            :key="a.value"
            type="button"
            class="item"
            :class="{ danger: a.danger, disabled: a.disabled }"
            role="menuitem"
            :aria-haspopup="a.children?.length ? 'menu' : undefined"
            :aria-expanded="a.children?.length && levels[i + 1]?.openedFrom === a.value ? 'true' : undefined"
            @click="onItemClick(a, $event, i)"
          >
            <component :is="a.icon" v-if="a.icon" class="ic" :size="18" :stroke-width="2" />
            <span class="lbl">{{ a.label }}</span>
            <ChevronRight v-if="a.children?.length" class="chev" :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </template>

    <!-- dialog：底部操作面板（遮罩 + 卡片），层级拍平为缩进分组 -->
    <template v-else>
      <Transition name="am-mask">
        <div v-if="open" class="mask" @click="closeAll" />
      </Transition>
      <Transition name="am-card">
        <div v-if="open" class="sheet" role="dialog" :aria-label="title ?? '操作'">
          <p v-if="title" class="stitle">{{ title }}</p>
          <template v-for="(f, fi) in flatActions" :key="`${f.item.value}-${fi}`">
            <p v-if="f.header" class="group" :style="{ paddingLeft: `${12 + f.depth * 22}px` }">
              {{ f.item.label }}
            </p>
            <button
              v-else
              type="button"
              class="item tall"
              :class="{ danger: f.item.danger, disabled: f.item.disabled }"
              :style="{ paddingLeft: `${12 + f.depth * 22}px` }"
              @click="emit('select', f.item.value); emit('close')"
            >
              <component :is="f.item.icon" v-if="f.item.icon" class="ic" :size="18" :stroke-width="2" />
              <span class="lbl">{{ f.item.label }}</span>
            </button>
          </template>
          <button type="button" class="item tall cancel" @click="closeAll">取消</button>
        </div>
      </Transition>
    </template>
  </Teleport>
</template>

<style scoped>
.catcher {
  position: fixed;
  inset: 0;
  z-index: 114;
  background: transparent;
}

.panel {
  min-width: 180px;
  max-width: 280px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-m);
  padding: 6px;
  box-shadow: var(--shadow-float);
}

.ptitle {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
  padding: 8px 12px 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border-radius: var(--radius-s);
  font-size: var(--fs-callout);
  font-weight: 500;
  color: var(--text-1);
  text-align: left;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.item:active {
  background: var(--surface-2);
}

.item .lbl {
  flex: 1;
  min-width: 0;
}

.item .chev {
  flex: none;
  color: var(--text-3);
}

.item .ic {
  flex: none;
  color: var(--text-2);
}

.item.danger {
  color: var(--danger);
}

.item.danger .ic {
  color: var(--danger);
}

.item.disabled {
  opacity: 0.4;
}

/* dialog 模式底板（沿用 ActionSheet 的观感） */
.mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.sheet {
  position: fixed;
  bottom: calc(var(--tabbar-h) / 2 + 12px);
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 24px);
  max-width: calc(var(--frame-max) - 24px);
  z-index: 111;
  background: var(--surface);
  border-radius: var(--radius-l);
  padding: 8px;
  box-shadow: var(--shadow-float);
}

.stitle {
  text-align: center;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
  padding: 10px 0 6px;
}

.group {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
  padding: 10px 12px 4px;
}

.item.tall {
  min-height: 50px;
  border-radius: var(--radius-m);
  font-weight: 600;
}

.item.cancel {
  margin-top: 6px;
  border-top: 0.5px solid var(--line);
}

/* bind 面板进出：自锚点角缩放浮现；退出更快 */
.am-pop-enter-active {
  transition:
    transform 200ms var(--ease-standard),
    opacity 150ms var(--ease-standard);
}

.am-pop-leave-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.am-pop-enter-from,
.am-pop-leave-to {
  transform: scale(0.92);
  opacity: 0;
}

.am-mask-enter-active,
.am-mask-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.am-mask-enter-from,
.am-mask-leave-to {
  opacity: 0;
}

.am-card-enter-active {
  transition:
    transform var(--dur-sheet) var(--ease-sheet),
    opacity var(--dur-sheet) var(--ease-sheet);
}

.am-card-leave-active {
  transition:
    transform 200ms var(--ease-standard),
    opacity 200ms var(--ease-standard);
}

.am-card-enter-from,
.am-card-leave-to {
  transform: translate(-50%, 24px);
  opacity: 0;
}
</style>
