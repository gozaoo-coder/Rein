<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { toggleablePlugins, type PluginSpec } from '@/plugins'
import { useFeaturesStore } from '@/stores/features'

/**
 * 打开或关闭功能（三级页）：`src/plugins` 里声明了 `toggleable` 的功能模块逐项开关。
 * 这里只做开关本身——入口显隐、路由拦截、数据加载跳过全部由插件层统一生效。
 */
const features = useFeaturesStore()

/** 开关清单来自注册表，不是写死的数组：新增模块 = 加一个插件声明 */
const list: PluginSpec[] = toggleablePlugins()

/** 图标章配色：同色相淡彩底 + 深档前景，与主页工具格同一套约定 */
function iconStyle(p: PluginSpec): Record<string, string> {
  return {
    background: `color-mix(in srgb, var(${p.accent}) 12%, transparent)`,
    color: `var(${p.accent})`,
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="打开或关闭功能" back />

    <section class="card plist">
      <div v-for="p in list" :key="p.id" class="prow row" :class="{ off: !features.isEnabled(p.id) }">
        <i class="pic" :style="iconStyle(p)">
          <component :is="p.icon" :size="18" />
        </i>
        <span class="col ptxt">
          <b>{{ p.name }}</b>
          <em class="t-3">{{ p.desc }}</em>
        </span>
        <ToggleSwitch
          :model-value="features.isEnabled(p.id)"
          :label="`${p.name} 开关`"
          @update:model-value="features.setEnabled(p.id, $event)"
        />
      </div>
    </section>

    <p class="note t-3">
      关闭后入口与页面一起隐藏，已有数据原样保留，随时可以再打开。更多模块正在接入这套插件层。
    </p>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.plist {
  padding: 6px 20px;
}

.prow {
  gap: 12px;
  padding: 11px 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.prow + .prow {
  border-top: 0.5px solid var(--line);
}

/* 关闭态整行降透明：开关本身仍在，但一眼能看出这一行没在生效 */
.prow.off .pic,
.prow.off .ptxt {
  opacity: 0.5;
}

.pic {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
}

.ptxt {
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.ptxt b {
  font-size: var(--fs-body);
  font-weight: 600;
}

.ptxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: 1.4;
}

.note {
  margin: 14px 4px 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
}
</style>
