<script setup lang="ts">
import { computed } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import { MACRO_GUIDES } from '@/config/dri'
import { macroStatsFrom, useNutritionStore } from '@/stores/nutrition'
import type { DailySummary } from '@/types'

/** 宏量营养素详解：当日进度数值（色点 + 名称 + 当前 / 目标）；作用与来源说明收进标题行 InfoHint。
 *  钠不进这张卡：它是上限类营养素，与其它微量元素一同在「微量元素」卡对照（那边有进度条
 *  与「上限」标注，且宏量卡只留三大宏量，与摄入总览过滤钠的域惯例一致）。
 *  默认读 nutrition store 的「今天」；传了 `summary` 就按那一份渲染（饮食历史回看某一天），
 *  与「摄入总览 / 微量元素」用的是同一份汇总。 */
const props = defineProps<{
  /** 指定日期的汇总；不传则用 store 的「今天」 */
  summary?: DailySummary | null
}>()

const n = useNutritionStore()

/** 区分「没传」与「传了 null」：前者回落 store，后者是「这天还没拿到数据」 */
const data = computed(() => (props.summary === undefined ? n.summary : props.summary))

const rows = computed(() =>
  // 钠只留在「微量元素」卡（那边有进度条与「上限」标注）：一张屏里同一个营养素只出现一处分母
  MACRO_GUIDES.map((g) => {
    const m = macroStatsFrom(data.value).find((x) => x.key === g.key)
    return {
      ...g,
      current: Math.round(m?.current ?? 0),
      target: Math.round(m?.target ?? 0),
      unit: m?.unit ?? 'g',
    }
  }).filter((r) => r.key !== 'sodiumMg'),
)
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>宏量营养素</h2>
      <!-- 目标口径与科普全文收进标题行右侧一枚 InfoHint；卡面每行只留色点 + 名称 + 当前 / 目标 -->
      <InfoHint class="hint" title="宏量营养素">
        <p>行内「当前 / 目标」的目标取每日营养目标（在「饮食调整」页调整）。钠是上限类营养素，与其它微量元素一同放在「微量元素」卡对照。</p>
        <ul class="hint-list">
          <li v-for="r in rows" :key="r.key"><b>{{ r.label }}</b>：{{ r.desc }}</li>
        </ul>
      </InfoHint>
    </header>

    <ul class="list">
      <li v-for="r in rows" :key="r.key" class="item">
        <div class="row between top">
          <span class="name row center">
            <i class="dot" :style="{ background: `var(${r.colorVar})` }" />
            {{ r.label }}
          </span>
          <span class="num val">
            {{ r.current }}<em> / {{ r.target }} {{ r.unit }}</em>
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 卡头是 flex 行：标题 + 帮助入口同行（入口在标题右端） */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head .hint {
  margin-left: auto;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

/* InfoHint 插槽：科普全文（config/dri 的 desc）走列表 */
.hint-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
}

.hint-list li {
  line-height: 1.5;
}

.hint-list b {
  font-weight: 600;
}

.list {
  margin-top: 6px;
}

.item {
  padding: 12px 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.top {
  margin-bottom: 4px;
}

.name {
  gap: 7px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.val {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.val em {
  font-style: normal;
  font-weight: 400;
  color: var(--text-3);
  font-size: var(--fs-caption);
  margin-left: 2px;
}
</style>
