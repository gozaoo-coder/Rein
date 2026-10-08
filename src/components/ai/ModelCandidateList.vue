<script setup lang="ts">
/**
 * 候选模型列表（纯展示）：按提供商折叠 + 提供商前缀 + 当前项打勾。
 *
 * 折叠是**本地开关**（点分组标题收起/展开），默认全展开 —— 默认收起会让
 * 「找某一家的模型」多一次点击，反而更慢。搜索框在父组件（工具栏）里，
 * 这里只负责把已经过滤好的行画出来。
 */
import { computed, ref } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

import { groupByProvider, modelDisplayName } from '@/ai/providerCatalog'
import type { ModelCandidate } from '@/types'

const props = withDefaults(
  defineProps<{
    items: ModelCandidate[]
    folder: boolean
    display: boolean
    /** 当前生效项的 ref（行尾打勾） */
    currentRef?: string
    emptyText?: string
    /** 行高亮（提供商目录里「已启用」的行用） */
    activeOf?: (c: ModelCandidate) => boolean
  }>(),
  { currentRef: '', emptyText: '没有匹配的模型', activeOf: undefined },
)

const emit = defineEmits<{ select: [string] }>()

const collapsed = ref<Set<string>>(new Set())

const groups = computed(() => groupByProvider(props.items, (c) => c.provider, props.folder))

function toggle(name: string): void {
  const next = new Set(collapsed.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsed.value = next
}

function labelOf(c: ModelCandidate): string {
  return modelDisplayName(c.label, c.provider, props.display)
}

function isOn(c: ModelCandidate): boolean {
  if (props.activeOf) return props.activeOf(c)
  return !!props.currentRef && c.ref === props.currentRef
}
</script>

<template>
  <div class="wrap">
    <p v-if="items.length === 0" class="none t-3">{{ emptyText }}</p>
    <section v-for="g in groups" v-else :key="g.provider || '_'" class="grp">
      <button
        v-if="folder && g.provider"
        type="button"
        class="grp-head"
        :aria-expanded="!collapsed.has(g.provider)"
        @click="toggle(g.provider)"
      >
        <ChevronDown :size="14" class="chev" :class="{ shut: collapsed.has(g.provider) }" />
        <b>{{ g.provider }}</b>
        <span class="cnt t-3">{{ g.items.length }}</span>
      </button>
      <ul v-show="!collapsed.has(g.provider)" class="list">
        <li v-for="c in g.items" :key="c.ref">
          <button
            type="button"
            class="row center item"
            :class="{ on: isOn(c) }"
            :disabled="c.disabled"
            @click="emit('select', c.ref)"
          >
            <span class="flex-1 min0 txt">
              <b>
                {{ labelOf(c) }}
                <i v-if="c.badge" class="badge">{{ c.badge }}</i>
              </b>
              <small>{{ c.sub }}</small>
            </span>
            <Check v-if="isOn(c)" :size="16" class="tick" />
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.none {
  text-align: center;
  padding: 26px 0;
  font-size: var(--fs-footnote);
}

.grp {
  display: flex;
  flex-direction: column;
}

.grp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 2px;
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 700;
  text-align: left;
}

.grp-head .chev {
  flex: none;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.grp-head .chev.shut {
  transform: rotate(-90deg);
}

.grp-head .cnt {
  font-weight: 600;
}

.list {
  display: flex;
  flex-direction: column;
}

.item {
  gap: 10px;
  width: 100%;
  padding: 11px 2px;
  text-align: left;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.item:disabled {
  opacity: 0.45;
}

.item.on {
  color: var(--accent);
}

.txt b {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-body);
  font-weight: 600;
  word-break: break-all;
}

.txt small {
  display: block;
  margin-top: 2px;
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: 1.45;
  word-break: break-all;
}

.badge {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 800;
  padding: 2px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

.item.on .badge {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.tick {
  flex: none;
  color: var(--accent);
}
</style>
