<script setup lang="ts">
import { computed } from 'vue'

import PageHeader from '@/components/layout/PageHeader.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { toggleablePlugins, type PluginSpec } from '@/plugins'
import { useFeaturesStore } from '@/stores/features'

/**
 * 打开或关闭功能（三级页）：`src/plugins` 里声明了 `toggleable` 的功能模块逐项开关。
 * 这里只做开关本身——入口显隐、路由拦截、数据加载跳过全部由插件层统一生效。
 *
 * 子模块（`parent` 非空，如「课表 › 抢课」）缩进挂在父模块下面：它继承父模块的可用性，
 * 父模块关掉时开关置灰并写明原因，而不是让人打开一个开了也没用的开关。
 */
const features = useFeaturesStore()

/** 开关清单来自注册表，不是写死的数组：新增模块 = 加一个插件声明 */
const rows = computed(() => {
  const all: PluginSpec[] = toggleablePlugins()
  return all
    .filter((p) => !p.parent)
    .map((p) => ({ plugin: p, children: all.filter((c) => c.parent === p.id) }))
})

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
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- d-full：开关清单这张卡通栏（壳层默认把 .page 的直接子级 .card 压成半栏） -->
    <section class="card d-full plist">
      <template v-for="row in rows" :key="row.plugin.id">
        <div class="prow row" :class="{ off: !features.isEnabled(row.plugin.id) }">
          <i class="pic" :style="iconStyle(row.plugin)">
            <component :is="row.plugin.icon" :size="18" />
          </i>
          <span class="col ptxt">
            <b>{{ row.plugin.name }}</b>
            <em class="t-3">{{ row.plugin.desc }}</em>
          </span>
          <ToggleSwitch
            :model-value="features.isEnabled(row.plugin.id)"
            :label="`${row.plugin.name} 开关`"
            @update:model-value="features.setEnabled(row.plugin.id, $event)"
          />
        </div>

        <!-- 子模块：缩进一格 + 左侧一条引导线，看着就是「属于上面那个模块」 -->
        <div
          v-for="child in row.children"
          :key="child.id"
          class="prow sub row"
          :class="{ off: !features.isEnabled(child.id) }"
        >
          <i class="pic sm" :style="iconStyle(child)">
            <component :is="child.icon" :size="15" />
          </i>
          <span class="col ptxt">
            <!-- 「子模块」标记放在 <b> **外面**：它是装饰，不该混进这一行的名字里
                 （e2e 与无障碍都按 b 的文本认行） -->
            <span class="namerow">
              <b>{{ child.name }}</b>
              <i class="tag">子模块</i>
            </span>
            <em class="t-3">
              {{ child.desc }}
              <template v-if="!features.isEnabled(row.plugin.id)">
                · {{ row.plugin.name }}关闭时不可用
              </template>
            </em>
          </span>
          <ToggleSwitch
            :model-value="features.isEnabled(child.id)"
            :label="`${child.name} 开关`"
            :disabled="!features.isEnabled(row.plugin.id)"
            @update:model-value="features.setEnabled(child.id, $event)"
          />
        </div>
      </template>
    </section>

    <p class="note t-3">
      关闭后入口与页面一起隐藏，已有数据原样保留，随时可以再打开。子模块默认关闭，
      开启后它才真正开始工作（含后台任务）。更多模块正在接入这套插件层。
    </p>
    </div>
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

/* 子模块：缩进 + 引导线。行内分隔线改挂到引导线上，避免两条线并排 */
.prow.sub {
  margin-left: 14px;
  padding-left: 14px;
  border-top: 0;
  position: relative;
}

.prow.sub::before {
  content: '';
  position: absolute;
  left: 0;
  top: -1px;
  bottom: 0;
  width: 1px;
  background: var(--line);
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

.pic.sm {
  width: 28px;
  height: 28px;
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

.namerow {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ptxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: 1.4;
}

/* 「子模块」标记：中性底 + 次级文字色，不用强调色抢注意力 */
.tag {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  color: var(--text-3);
  background: var(--surface-2);
}

.note {
  margin: 14px 4px 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   开关清单只有寥寥几行，却被壳层压成半栏、右半屏空着。这张卡应当通栏 ——
   它是一份「模块清单」，每行的开关都贴在卡右缘，读起来是一张表，摊成两栏反而会把
   子模块（抢课）从它的父模块（课表）身边拆走（栅格逐行填充，父子会被分到不同栏）。

   通栏由模板上的 .d-full 声明。 */
</style>
