<script setup lang="ts">
/**
 * 模型列表工具栏：搜索 + 两条「渲染声明」开关 + 计数。
 *
 * 两条声明直接对应列表的两种渲染方式（用户可在抽屉里当场切换、并被记住）：
 * - **提供商前缀**：模型名前加提供商昵称，跨供应商时一眼看出归属；
 * - **按提供商折叠**：按供应商分组，找某一家的模型不用在长列表里翻。
 *
 * 所有模型列表（选择抽屉 / 全部模型 / 提供商目录）共用这一条，尺寸与说法只有一份。
 */
import { Search, Tags, Rows3 } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    query: string
    count: number
    /** 未过滤时的总数（count < total 时显示「x / y」） */
    total?: number
    folder: boolean
    display: boolean
    placeholder?: string
    loading?: boolean
  }>(),
  { total: 0, placeholder: '搜索模型名或提供商', loading: false },
)

const emit = defineEmits<{
  'update:query': [string]
  'update:folder': [boolean]
  'update:display': [boolean]
}>()
</script>

<template>
  <div class="bar">
    <div class="finder row center">
      <Search :size="16" class="t-3" />
      <input
        type="text"
        :value="query"
        :placeholder="placeholder"
        aria-label="搜索模型"
        autocapitalize="off"
        spellcheck="false"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      >
      <span v-if="loading" class="cnt t-3">加载中…</span>
    </div>

    <div class="row between center flags">
      <div class="row gap">
        <button
          type="button"
          class="flag"
          :class="{ on: display }"
          :aria-pressed="display"
          @click="emit('update:display', !display)"
        >
          <Tags :size="12" />
          提供商前缀
        </button>
        <button
          type="button"
          class="flag"
          :class="{ on: folder }"
          :aria-pressed="folder"
          @click="emit('update:folder', !folder)"
        >
          <Rows3 :size="12" />
          按提供商折叠
        </button>
      </div>
      <span class="cnt t-3">{{ count }}<template v-if="total > count"> / {{ total }}</template> 条</span>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.finder {
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.finder input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.flags {
  gap: 8px;
}

.flag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.flag.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.cnt {
  font-size: var(--fs-micro);
  flex: none;
}
</style>
