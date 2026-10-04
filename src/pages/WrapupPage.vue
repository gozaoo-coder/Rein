<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import PageHeader from '@/components/layout/PageHeader.vue'
import RingProgress from '@/components/common/RingProgress.vue'
import { useProgramStore } from '@/stores/program'
import { GOAL_LABELS } from '@/config/domain'
import type { ProgramRecord } from '@/types'
import { fmtRate, fmtWeightDelta, reportSpanDays } from '@/utils/programReport'
import { buildWrapup, wrapupSubtitle, type WrapupData } from '@/utils/programWrapup'

/**
 * 结营成绩单：一份方案结束后的对照与庆祝。
 *
 * 完成度大数字诚实呈现；「开始 → 结束」回答「有没有用」；徽章按数据规则颁发；
 * 底部直接给下一期档位建议——归档不是终点，是中转站。
 */
const router = useRouter()
const store = useProgramStore()

const phase = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const record = ref<ProgramRecord | null>(null)
const data = ref<WrapupData | null>(null)
const loadError = ref('')

onMounted(async () => {
  try {
    await store.load()
    const id = Number(router.currentRoute.value.params.id)
    const rec = store.history.find((r) => r.id === id) ?? null
    if (!rec) {
      phase.value = 'missing'
      return
    }
    record.value = rec
    data.value = await buildWrapup(rec)
    phase.value = 'ready'
  } catch (e) {
    // 方案数据损坏或读取失败时要给出出口，否则永远停在「加载中」
    loadError.value = e instanceof Error ? e.message : '结营数据读取失败'
    phase.value = 'error'
  }
})

const subtitle = computed(() => (record.value ? wrapupSubtitle(record.value) : ''))

const tierLabel = computed(() => {
  const t = record.value?.tier
  return t === 'conservative' ? '保守' : t === 'aggressive' ? '进取' : '均衡'
})

const completionText = computed(() =>
  data.value?.completion != null ? `${Math.round(data.value.completion * 100)}%` : '—',
)

const nextTierLabel = computed(() => {
  const t = data.value?.nextTier
  return t === 'conservative' ? '保守' : t === 'aggressive' ? '进取' : '均衡'
})

/** 方案期内体重变化（首条 → 末条），无数据时 null */
const weightDelta = computed<number | null>(() => {
  const d = data.value
  if (!d) return null
  const { before, after } = d.compare.weight
  if (before == null || after == null) return null
  return Math.round((after - before) * 10) / 10
})

/** 体重变化的方向色：与目标同向 = good，反向 = bad，持平无色 */
function deltaCls(c: { before: number | null; after: number | null }): string {
  if (c.before == null || c.after == null) return ''
  const move = c.after - c.before
  if (Math.abs(move) < 0.05) return ''
  const goal = record.value?.goal
  if (goal === 'keep') return ''
  const good = goal === 'bulk' ? move > 0 : move < 0
  return good ? 'good' : 'bad'
}

const heroStats = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { em: '坚持', value: d.streakDays, unit: '天' },
    { em: '训练', value: d.report.training.done, unit: '次' },
    { em: '记录', value: d.report.recordedDays, unit: '天' },
    { em: '调整', value: d.report.adjustmentsCount, unit: '次' },
  ]
})

/** 归档状态决定 CTA：历史方案直接开下一期；生效中的先归档 */
const isActive = computed(() => record.value?.status === 'active')
const archiving = ref(false)

async function nextPhase(): Promise<void> {
  if (!record.value) return
  if (isActive.value) {
    archiving.value = true
    try {
      await store.archive(record.value.id)
    } finally {
      archiving.value = false
    }
  }
  void router.push('/program')
}
</script>

<template>
  <div class="page">
    <PageHeader title="结营成绩单" back />

    <section v-if="phase === 'loading'" class="card center empty">
      <span class="t-3">正在汇总执行数据…</span>
    </section>

    <section v-else-if="phase === 'missing'" class="card center empty">
      <span class="t-3">没有找到这份方案</span>
      <button class="primary" @click="router.replace('/program')">回健康方案</button>
    </section>

    <section v-else-if="phase === 'error'" class="card center empty">
      <span class="t-3">{{ loadError }}</span>
      <button class="primary" @click="router.replace('/program')">回健康方案</button>
    </section>

    <template v-else-if="data && record">
      <!-- 完成度 -->
      <section class="pod hero">
        <p class="eyebrow">{{ subtitle }}</p>
        <p class="hero-title">你坚持下来了</p>
        <RingProgress
          :value="data.completion ?? 0"
          color-var="--c-exercise"
          :size="112"
          :stroke="11"
        >
          <b class="num ring-num">{{ completionText }}</b>
          <span class="ring-cap">完成度</span>
        </RingProgress>
        <ul class="statgrid num">
          <li v-for="s in heroStats" :key="s.em">
            <em>{{ s.em }}</em>
            <b>{{ s.value }}<i>{{ s.unit }}</i></b>
          </li>
        </ul>
      </section>

      <!-- 开始 → 结束 -->
      <section class="pod compare">
        <header class="pod-head"><b>开始 → 结束</b></header>
        <ul class="rows">
          <li>
            <span class="lbl">体重</span>
            <span class="val num">
              {{ data.compare.weight.before ?? '—' }} →
              <b :class="deltaCls(data.compare.weight)">{{ fmtWeightDelta(weightDelta) }}</b>
            </span>
          </li>
          <li>
            <span class="lbl">日均摄入</span>
            <span class="val num">{{ data.compare.intake.before ?? '—' }} → <b>{{ data.compare.intake.after ?? '—' }} 大卡</b></span>
          </li>
          <li>
            <span class="lbl">训练频率</span>
            <span class="val num">{{ data.compare.trainingFreq.before }} → <b>{{ data.compare.trainingFreq.after }} 次/周</b></span>
          </li>
          <li>
            <span class="lbl">日程完成</span>
            <span class="val num">
              {{ fmtRate(data.report.schedule.done, data.report.schedule.planned) }}
              <span class="t-3">（{{ data.report.schedule.done }}/{{ data.report.schedule.planned }} 项）</span>
            </span>
          </li>
        </ul>
        <p class="t-3 span-note num">
          {{ data.report.startDate }} ~ {{ data.report.endDate }} · 共 {{ reportSpanDays(data.report.startDate, data.report.endDate) }} 天 · 运动 {{ data.report.actual.count }} 次（{{ data.report.actual.minutes }} 分钟）· 消耗 {{ data.report.actual.kcal }} 大卡
        </p>
      </section>

      <!-- 徽章 -->
      <section v-if="data.badges.length" class="pod badges">
        <header class="pod-head">
          <b>获得 {{ data.badges.length }} 枚徽章</b>
        </header>
        <ul class="badges">
          <li v-for="b in data.badges" :key="b.title">
            <i class="bemoji">{{ b.emoji }}</i>
            <div>
              <p class="btitle">{{ b.title }}</p>
              <p class="bsub t-3">{{ b.sub }}</p>
            </div>
          </li>
        </ul>
      </section>

      <!-- 下一期 -->
      <section class="callout">
        <b>下一期建议</b>：{{ data.nextTierText }}
      </section>

      <button class="primary" :disabled="archiving" @click="nextPhase">
        {{ archiving ? '正在归档…' : isActive ? `归档并开启下一期（${nextTierLabel}档起步）` : `开启下一期（${nextTierLabel}档起步）` }}
      </button>

      <!-- 完整报告 -->
      <section class="pod report">
        <header class="pod-head"><b>完整报告</b><span class="t-3 num">{{ GOAL_LABELS[record.goal] }} · {{ tierLabel }} · v{{ record.version }}</span></header>
        <ul class="rstats num">
          <li><em>平均摄入</em><b>{{ data.report.avgIntake ?? '—' }}</b><i>目标 {{ data.report.targetKcal }} 大卡</i></li>
          <li><em>训练兑现</em><b>{{ fmtRate(data.report.training.done, data.report.training.planned) }}</b><i>{{ data.report.training.done }}/{{ data.report.training.planned }} 次（含运动记录与日程勾选）</i></li>
          <li><em>真实运动</em><b>{{ data.report.actual.count }} 次</b><i>含跟课 {{ data.report.actual.sessions }} 次 · 有记录 {{ data.report.recordedDays }} 天饮食</i></li>
          <li><em>体重变化</em><b>{{ fmtWeightDelta(data.report.weightDeltaKg) }}</b><i>消耗 {{ data.report.actual.kcal }} 大卡</i></li>
        </ul>
        <p class="t-3 rnote">
          方案日程勾选 {{ data.report.schedule.done }}/{{ data.report.schedule.planned }} 项 ·
          期间调整 {{ data.report.adjustmentsCount }} 次；未记录的饮食日不参与平均摄入统计。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.empty {
  padding: 40px 0;
  display: grid;
  gap: 14px;
}

.pod {
  margin-bottom: 12px;
  padding: 15px 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.pod-head b {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

/* 完成度英雄区 */
.hero {
  text-align: center;
  padding: 22px 16px;
}

.eyebrow {
  font-size: var(--fs-micro);
  letter-spacing: 0.1em;
  color: var(--text-3);
  font-weight: 600;
}

.hero-title {
  margin: 6px 0 16px;
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.4px;
}

.ring-num {
  display: block;
  font-size: 26px;
  font-weight: 700;
}

.ring-cap {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.statgrid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.statgrid em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.statgrid b {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.statgrid i {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: 400;
  margin-left: 1px;
}

/* 对照行 */
.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-subhead);
}

.rows li:first-child {
  border-top: none;
}

.lbl {
  color: var(--text-2);
}

.val b {
  font-weight: 700;
}

.val b.good {
  color: var(--ok-strong);
}

.val b.bad {
  color: var(--danger);
}

.span-note {
  margin-top: 8px;
  font-size: var(--fs-micro);
}

/* 徽章 */
.badges {
  display: grid;
  gap: 10px;
}

.badges li {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bemoji {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--c-exercise-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-style: normal;
}

.btitle {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.bsub {
  margin-top: 1px;
  font-size: var(--fs-caption);
}

.callout {
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.6;
}

.callout b {
  color: var(--text-1);
}

.primary {
  width: 100%;
  margin-bottom: 12px;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
}

.primary:disabled {
  opacity: 0.45;
}

/* 完整报告 */
.rstats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.rstats li {
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.rstats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.rstats b {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-title3);
  font-weight: 700;
}

.rstats i {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.rnote {
  margin-top: 10px;
  font-size: var(--fs-footnote);
  line-height: 1.5;
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   .pod / .callout / .primary 不是 .card，壳层缺省已经让它们通栏；
   这里只补两件事：空态卡片也要通栏，以及把成绩单排成「通栏英雄区 + 左右两栏」。
   选择器里带上 section/button 元素名是为了压过壳层给 .page 子项定的栅格位。
   ============================================================ */

/* 页头钉在第 1 行：它是 sticky 的，如果不显式给行号，自动排布会绕开
   下面这些被显式占位的行，把它挤到最后一行的位置（页头跑到页脚去） */
.desk-main .page > .page-header {
  grid-row: 1;
  grid-column: 1 / -1;
}

/* 单张空态卡片在半栏里右半屏全空 —— 它本来就该是整屏一句话 */
.desk-main .page > section.card.empty {
  grid-row: 2;
  grid-column: 1 / -1;
}

/* 完成度英雄区：一个环 + 四条数字，通栏居中才撑得住这页的气势 */
.desk-main .page > section.pod.hero {
  grid-row: 2;
  grid-column: 1 / -1;
}

/* 对照与报告是这页的正文：并排两栏，一屏读完「有没有用」 */
.desk-main .page > section.pod.compare {
  grid-row: 3;
  grid-column: 1;
}

.desk-main .page > section.pod.report {
  grid-row: 3 / span 2;
  grid-column: 2;
}

/* 徽章是短列表，落在左栏对照下方 */
.desk-main .page > section.pod.badges {
  grid-row: 4;
  grid-column: 1;
}

/* 下一期建议与 CTA 保持通栏：一条结论 + 一枚决定下一步的按钮，
   横跨整屏读起来才是「结论 → 行动」的顺序 */
.desk-main .page > section.callout {
  grid-row: 5;
  grid-column: 1 / -1;
}

.desk-main .page > button.primary {
  grid-row: 6;
  grid-column: 1 / -1;
}

/* 栅格用 gap 管行距，卡片自身那 12px 的下边距要收掉 */
.desk-main .page > .pod,
.desk-main .page > .callout,
.desk-main .page > .primary {
  margin-bottom: 0;
}
</style>
