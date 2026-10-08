<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronRight, Lock, Pin } from 'lucide-vue-next'

import FileIcon from './FileIcon.vue'
import { checkName, extChanged, formatFullWhen, formatWhen, kindLabel, splitExt } from '@/files/sort'
import type { ColumnDef } from '@/files/registry'
import type { FileItem } from '@/files/types'
import { KB_SOURCE_LABELS, type KbSourceType } from '@/types'
import { humanBytes } from '@/utils/format'

/**
 * 列表里的一行。
 *
 * 两套布局由 `wide` 切换（同一个组件，不是两个组件）：宽屏走表格式多列，
 * 窄屏走「名称 / 元信息」两行 —— 移动端把四列硬塞进 360px 只会挤成一条缝。
 * 两种布局共享同一份状态与交互（选择、拖拽、就地改名），所以不存在行为漂移。
 */
const props = withDefaults(
  defineProps<{
    item: FileItem
    selected: boolean
    focused: boolean
    cut: boolean
    dragOver: boolean
    editing: boolean
    /** 宽屏：表格式多列 */
    wide?: boolean
    /** 宽屏要显示的列（来自列注册表，用户在列菜单里选过） */
    columns?: ColumnDef[]
    /** 剪贴板非空时高亮「可以粘贴进来」的目录 */
    pasteTarget?: boolean
  }>(),
  { wide: false, pasteTarget: false, columns: () => [] },
)

const emit = defineEmits<{
  activate: [item: FileItem, ev: MouseEvent]
  open: [item: FileItem]
  menu: [item: FileItem, ev: MouseEvent]
  dragStart: [item: FileItem, ev: DragEvent]
  dragEnd: []
  /** 悬停（dragenter/dragover 期间持续触发）：只做高亮 */
  dragOver: [item: FileItem, ev: DragEvent]
  /** 落下：只触发一次，真正执行移动/复制 */
  drop: [item: FileItem, ev: DragEvent]
  renameCommit: [item: FileItem, name: string]
  renameCancel: []
}>()

const nameInput = ref<HTMLInputElement | null>(null)
const draft = ref('')
const nameError = ref('')

/** 源标签：派生投影标注它来自哪一类应用数据（notes 不必标） */
const sourceLabel = computed(() => {
  const st = props.item.sourceType
  if (!st || st === 'note') return ''
  return KB_SOURCE_LABELS[st as KbSourceType] ?? st
})

const sizeLabel = computed(() => {
  if (props.item.isDir) return props.item.childCount > 0 ? `${props.item.childCount} 项` : '空'
  return props.item.size !== undefined ? humanBytes(props.item.size) : ''
})

const timeLabel = computed(() => formatWhen(props.item.modifiedAt))

const metaLine = computed(() => {
  const bits = [kindLabel(props.item.kind)]
  if (sourceLabel.value) bits.push(sourceLabel.value)
  if (props.item.isDir) bits.push(sizeLabel.value)
  else if (sizeLabel.value) bits.push(sizeLabel.value)
  if (timeLabel.value) bits.push(timeLabel.value)
  return bits.join(' · ')
})

/** 读屏要读全：名称、类型、大小、修改时间、选中态（由 aria-selected 给） */
const ariaLabel = computed(() => {
  const bits = [props.item.name, kindLabel(props.item.kind)]
  if (props.item.isDir) bits.push(sizeLabel.value || '空目录')
  else if (props.item.size !== undefined) bits.push(humanBytes(props.item.size))
  if (props.item.modifiedAt) bits.push(`修改于 ${formatFullWhen(props.item.modifiedAt)}`)
  if (props.item.attributes.system) bits.push('系统文件，只读')
  else if (props.item.attributes.readOnly) bits.push('只读')
  if (props.item.pinned) bits.push('已钉住')
  if (props.cut) bits.push('待剪切')
  return bits.join('，')
})

/* ---------- 就地改名（F2） ---------- */

watch(
  () => props.editing,
  async (on) => {
    if (!on) return
    draft.value = props.item.name
    nameError.value = ''
    await nextTick()
    const el = nameInput.value
    if (!el) return
    el.focus()
    // 只选中主文件名，扩展名受保护（Windows/macOS 的老规矩）；无扩展名就全选
    const { stem } = splitExt(props.item.name)
    if (stem.length < props.item.name.length) el.setSelectionRange(0, stem.length)
    else el.select()
  },
)

function commitRename(): void {
  const next = draft.value.trim()
  if (next === props.item.name) {
    emit('renameCancel')
    return
  }
  const check = checkName(next, props.item.name)
  if (!check.ok) {
    nameError.value = check.reason ?? '名称不合法'
    nameInput.value?.focus()
    return
  }
  if (extChanged(props.item.name, next)) {
    // 扩展名变了只提示不阻止：内容不会跟着变，用户可能就是想改
    nameError.value = '扩展名已改变，文件内容不会变；打开方式可能失效'
  }
  emit('renameCommit', props.item, next)
}
</script>

<template>
  <li
    class="row"
    :class="{ sel: selected, focus: focused, cut, over: dragOver, dir: item.isDir, paste: pasteTarget }"
    role="option"
    :data-item-id="item.id"
    :aria-selected="selected"
    :aria-label="ariaLabel"
  >
    <div
      class="hit"
      :draggable="!editing"
      @click="emit('activate', item, $event)"
      @dblclick="emit('open', item)"
      @contextmenu.prevent="emit('menu', item, $event)"
      @dragstart="emit('dragStart', item, $event)"
      @dragend="emit('dragEnd')"
      @dragover="emit('dragOver', item, $event)"
      @drop.stop="emit('drop', item, $event)"
    >
      <FileIcon :item="item" :size="18" />

      <!-- 就地改名：默认只选中主文件名（见 watch） -->
      <template v-if="editing">
        <span class="name-col">
          <input
            ref="nameInput"
            v-model="draft"
            class="rename"
            :aria-label="`重命名为 ${item.name}`"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="emit('renameCancel')"
            @keydown.stop
            @blur="commitRename"
          >
          <small v-if="nameError" class="err">{{ nameError }}</small>
        </span>
      </template>

      <template v-else-if="wide">
        <span
          v-for="c in columns"
          :key="c.key"
          class="col"
          :class="[`c-${c.key}`, { flex: c.flex, end: c.align === 'end' }]"
          :style="c.width ? { width: `${c.width}px` } : undefined"
        >
          <template v-if="c.key === 'name'">
            <b>{{ item.displayName }}</b>
            <!-- 扩展名只在显示名隐去了它时另标出来（否则等于把名字写两遍） -->
            <small v-if="item.extension && item.displayName !== item.name" class="ext">{{ item.extension }}</small>
          </template>
          <template v-else-if="c.key === 'kind'">{{ sourceLabel || c.value(item) }}</template>
          <template v-else>{{ c.value(item) }}</template>
        </span>
      </template>

      <template v-else>
        <span class="name-col">
          <b>{{ item.displayName }}</b>
          <small>{{ metaLine }}</small>
        </span>
      </template>

      <Lock v-if="item.attributes.system" :size="12" class="t-3 mark" />
      <Pin v-else-if="item.pinned" :size="12" class="t-3 mark" />
      <ChevronRight v-if="!editing && !wide" :size="15" class="t-3 chev" />
    </div>
  </li>
</template>

<style scoped>
.row {
  height: 100%;
}

.hit {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 0 10px;
  border-radius: var(--radius-m);
  cursor: default;
  user-select: none;
}

.hit:hover {
  background: var(--surface-2);
}

.row.sel .hit {
  background: var(--accent-soft);
}

/* 焦点与选中**用两种视觉**：只靠颜色区分选中态对看不见颜色的人等于没有状态 */
.row.focus .hit {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.row.cut .hit {
  opacity: 0.45;
}

.row.over .hit {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

/* 剪贴板非空时，目录行给出「可以放到这里」的暗示 */
.row.dir.paste .hit {
  box-shadow: inset 0 0 0 1px var(--line-strong);
}

.name-col {
  display: flex;
  align-items: baseline;
  gap: 5px;
  flex: 1;
  min-width: 0;
}

.name-col b {
  font-size: var(--fs-body);
  font-weight: 400;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.sel .name-col b {
  font-weight: 700;
}

.name-col small {
  display: block;
  font-size: var(--fs-caption);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ext {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.col {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 名称列吃剩余宽度；其余列宽由列定义以内联 style 给（列可配置） */
.col.flex {
  flex: 1;
  min-width: 0;
}

.col.end {
  text-align: right;
}

.mark,
.chev {
  flex: none;
}

.rename {
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1.5px var(--accent);
  color: var(--text-1);
  font-size: var(--fs-body);
}

.err {
  display: block;
  margin-top: 2px;
  color: var(--danger-strong);
  font-size: var(--fs-micro);
}
</style>
