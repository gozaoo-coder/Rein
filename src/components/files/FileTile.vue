<script setup lang="ts">
import { computed } from 'vue'
import { Lock, Pin } from 'lucide-vue-next'

import FileIcon from './FileIcon.vue'
import { formatWhen, kindLabel } from '@/files/sort'
import type { FileItem, IconSize } from '@/files/types'
import { humanBytes } from '@/utils/format'

/**
 * 网格里的一块。图标尺寸按档位给（小/中/大），信息只留「名称 + 一行元信息」——
 * 网格的价值在于一眼扫过视觉特征（图片缩略图），塞满文字反而看不清。
 */
const props = withDefaults(
  defineProps<{
    item: FileItem
    selected: boolean
    focused: boolean
    cut: boolean
    dragOver: boolean
    editing: boolean
    iconSize?: IconSize
    pasteTarget?: boolean
  }>(),
  { iconSize: 'md', pasteTarget: false },
)

const emit = defineEmits<{
  activate: [item: FileItem, ev: MouseEvent]
  open: [item: FileItem]
  menu: [item: FileItem, ev: MouseEvent]
  dragStart: [item: FileItem, ev: DragEvent]
  dragEnd: []
  /** 悬停（dragover 期间持续触发）：只做高亮 */
  dragOver: [item: FileItem, ev: DragEvent]
  /** 落下：只触发一次 */
  drop: [item: FileItem, ev: DragEvent]
}>()

const ICON_PX: Record<IconSize, number> = { sm: 28, md: 40, lg: 56 }

const metaLine = computed(() => {
  const bits: string[] = []
  if (props.item.isDir) bits.push(props.item.childCount > 0 ? `${props.item.childCount} 项` : '空')
  else {
    bits.push(kindLabel(props.item.kind))
    if (props.item.size !== undefined) bits.push(humanBytes(props.item.size))
  }
  const t = formatWhen(props.item.modifiedAt)
  if (t) bits.push(t)
  return bits.join(' · ')
})

const ariaLabel = computed(() => {
  const bits = [props.item.name, kindLabel(props.item.kind)]
  if (props.item.size !== undefined && !props.item.isDir) bits.push(humanBytes(props.item.size))
  if (props.item.attributes.system) bits.push('系统文件，只读')
  if (props.item.pinned) bits.push('已钉住')
  if (props.cut) bits.push('待剪切')
  return bits.join('，')
})
</script>

<template>
  <div
    class="tile"
    :class="{ sel: selected, focus: focused, cut, over: dragOver, dir: item.isDir, paste: pasteTarget }"
    role="option"
    :data-item-id="item.id"
    :aria-selected="selected"
    :aria-label="ariaLabel"
    :draggable="!editing"
    @click="emit('activate', item, $event)"
    @dblclick="emit('open', item)"
    @contextmenu.prevent="emit('menu', item, $event)"
    @dragstart="emit('dragStart', item, $event)"
    @dragend="emit('dragEnd')"
    @dragover="emit('dragOver', item, $event)"
    @drop.stop="emit('drop', item, $event)"
  >
    <div class="art">
      <FileIcon :item="item" :size="ICON_PX[iconSize]" badges />
      <Lock v-if="item.attributes.system" :size="11" class="corner" />
      <Pin v-else-if="item.pinned" :size="11" class="corner" />
    </div>
    <b class="cap">{{ item.displayName }}</b>
    <small class="sub">{{ metaLine }}</small>
  </div>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 10px 8px;
  border-radius: var(--radius-m);
  text-align: center;
  cursor: default;
  user-select: none;
}

.tile:hover {
  background: var(--surface-2);
}

.tile.sel {
  background: var(--accent-soft);
}

.tile.focus {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.tile.cut {
  opacity: 0.45;
}

.tile.over {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.art {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 60px;
}

.corner {
  position: absolute;
  right: -2px;
  bottom: -2px;
  color: var(--text-3);
}

.cap {
  width: 100%;
  font-size: var(--fs-footnote);
  font-weight: 400;
  color: var(--text-1);
  /* 两行截断：文件名普遍比一个格子宽，一行会让「报告2026-10-07 早」这类名字全变成省略号 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.tile.sel .cap {
  font-weight: 700;
}

.sub {
  width: 100%;
  font-size: var(--fs-micro);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
