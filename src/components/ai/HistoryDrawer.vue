<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquarePlus, X } from 'lucide-vue-next'

import { useAiStore } from '@/stores/ai'

/** 历史记录抽屉：会话列表（最新置顶）+ 新对话；点击切换会话。 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const ai = useAiStore()

/** 更新时间展示：今天 HH:mm，否则 MM-DD HH:mm */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

const list = computed(() => ai.chats)

async function onPick(id: string): Promise<void> {
  emit('close')
  await ai.selectChat(id)
}

async function onNew(): Promise<void> {
  emit('close')
  await ai.newChat()
}

function onMask(): void {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dk-mask">
      <div v-if="open" class="dk-mask" @click="onMask" />
    </Transition>
    <Transition name="dk-panel">
      <!-- 右侧栏 + 玻璃材质（2026-10-02）。
           两条改动的原因：
           1. **改到右侧**：这是左手拇指最难够到、右手拇指最自然的区域。这个抽屉的用途是
              「翻会话、换会话」——高频且单手操作，落在右手边比左侧顺手得多。
           2. **玻璃材质走 `.glass-surface`**：它是一份全局定义（styles/base.css 的六层叠法），
              不是这里自己写一套 —— 「两份定义必然漂」是这个仓付过代价的教训。
              `.glass-edge-l` 是**贴边修饰**：面板贴屏幕右缘，内侧（左）那条描边该留，
              其余三边不该画框（画了就是在屏幕边缘多一条亮线）。
              ⚠️ 不带 `url()` 折射：折射有预算，只给面积够小的离散控件（见 docs/ARCHITECTURE.md）；
              抽屉是大面积表面，按规范只走材质升级。 -->
      <aside
        v-if="open"
        class="dk-panel glass-surface glass-edge-l"
        role="dialog"
        aria-label="历史记录"
      >
        <header class="dk-head row between center">
          <h2>历史记录</h2>
          <div class="row center">
            <button class="dk-new row center" aria-label="新对话" @click="onNew">
              <MessageSquarePlus :size="15" />
              新对话
            </button>
            <button class="dk-close" aria-label="关闭" @click="emit('close')">
              <X :size="18" />
            </button>
          </div>
        </header>

        <ul class="dk-list" data-rubber-self>
          <li v-for="c in list" :key="c.id">
            <button
              class="dk-item"
              :class="{ on: c.id === ai.chatId }"
              @click="onPick(c.id)"
            >
              <p class="dk-title">{{ c.title }}</p>
              <p class="dk-time t-3">{{ fmtTime(c.updatedAt) }}</p>
            </button>
          </li>
        </ul>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dk-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

/* 右侧栏：贴右缘、圆角在左侧两角。
   底 / 受光边 / 光学层 / 模糊全部交给 `.glass-surface`（全局那一份），
   这里**刻意不写 background 与 box-shadow** —— 本组件的 scoped 选择器带 [data-v]，
   特指度压过 `.glass-surface`，一写就会把玻璃的底顶掉、退化成实底。
   （同一个坑在 base.css 的注释里记过：`.glass-surface` 的底是 background 渐变，
   不是 background-color，覆盖一半就会得到「有描边没材料」的怪东西。）

   ---------- 浓度：玻璃底必须比默认厚（实测定的，不是拍的） ----------
   `.glass-surface` 出厂用 `--glass-fill`（白 52%）。这对悬浮的**小控件**没问题，
   对**承载可读文字的大面板**不行：抽屉背后是滚动的正文，深色内容滚过来时
   实测底会掉到 133 灰，标题（`--text-1`）只剩 4.56:1，够不着本仓 7:1 的门槛。

   所以这里就地把 `--glass-fill` 换成 `--surface` 的 70% —— 与 ToastHost 同一条思路
   （「同一套材质、不同浓度」，见其文件头），但浓度是按这个抽屉自己的门槛算的：
   70% 在**背后纯黑**这一极端下仍有 7.9:1 余量，而且它在**弱档**（全局关掉 blur）也读得清 ——
   弱档下玻璃退成半透明膜，浓度不够就会糊在正文上，这一条比"看起来更像玻璃"重要。
   代价是玻璃更实、背后的内容更糊：一个承载文字的导航面板该是这个取舍。 */
.dk-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 111;
  width: min(320px, 86vw);
  --glass-fill: color-mix(in srgb, var(--surface) 70%, transparent);
  border-radius: var(--radius-l) 0 0 var(--radius-l);
  display: flex;
  flex-direction: column;
  padding: var(--safe-top, 0px) 0 0;
}

.dk-head {
  padding: 16px 14px 10px;
  gap: 8px;
}

.dk-head h2 {
  font-size: var(--fs-headline);
  font-weight: 700;
  flex: 1;
  min-width: 0;
}

.dk-new {
  gap: 5px;
  padding: 7px 12px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-caption);
  font-weight: 700;
  flex: none;
}

.dk-close {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dk-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px calc(var(--safe-bottom, 0px) + 14px);
  scrollbar-width: none;
}

.dk-item {
  width: 100%;
  text-align: left;
  padding: 12px 12px;
  margin-bottom: 6px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* 选中项：文字用 `--accent-strong` 而不是 `--accent`。
   它坐在 `color-mix(--accent 13%, --surface-2)` 的浅蓝底上，用 `--accent` 实测只有 3.32:1
   （本仓门槛 7:1 对正文）——`--accent-strong` 这个令牌存在的理由就是这一条，
   见 tokens.css 里它的注释：「accent-soft 底或白底上的文字蓝」。 */
.dk-item.on {
  background: color-mix(in srgb, var(--accent) 13%, var(--surface-2));
}

.dk-item.on .dk-title {
  color: var(--accent-strong);
}

/* 选中项的时间同样要抬一档：它压在更深的浅蓝底上，`--text-3` 实测只剩 2.73:1
   （连它自己 3:1 的门槛都够不着）。未选中时用的仍是 `--text-3`，那一档 3.24:1 是达标的。 */
.dk-item.on .dk-time {
  color: var(--text-2);
}

.dk-title {
  font-size: var(--fs-subhead);
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dk-time {
  font-size: var(--fs-caption);
}

/* 抽屉动效 */
.dk-mask-enter-active,
.dk-mask-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.dk-mask-enter-from,
.dk-mask-leave-to {
  opacity: 0;
}

.dk-panel-enter-active {
  transition: transform var(--dur-sheet) var(--ease-sheet);
}

/* 退出更快：收起不恋战 */
.dk-panel-leave-active {
  transition: transform var(--dur-base) var(--ease-standard);
}

.dk-panel-enter-from,
.dk-panel-leave-to {
  transform: translateX(100%);
}
</style>
