<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight, Sparkles } from 'lucide-vue-next'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import MuscleCatchupSheet from '@/components/exercise/MuscleCatchupSheet.vue'
import TrainingScoreSheet from '@/components/exercise/TrainingScoreSheet.vue'
import { sessionService } from '@/services/sessionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { todayStr } from '@/utils/date'
import { computeTrainingScore, groupLevelMap, groupTooltipMap, type TrainingScoreResult } from '@/utils/trainingScore'
import { weakGroups } from '@/utils/weakMuscles'

/**
 * 肌肉热力图卡（运动页）：本周每块肌肉的**练够分**（《练够分 Lite》0–100，100 = 运动充分）。
 *
 * 呈现分两块，一块回答「哪里没练够」、一块回答「为什么、怎么补」：
 *  1. **身体热力图**（MuscleMap 的 heat 模式）：一眼看出分布 —— 正面/背面/侧面三视图，
 *     每块肌肉按所属评估组的练够分上色（低→高：红 / 琥珀 / 浅绿 / 实绿，未练为灰）。
 *     用图而不是只用列表，是因为「背没练够」这种事在列表里要靠读名字，在图上是一眼的事。
 *  2. **练够分说明抽屉**（TrainingScoreSheet）：以图表 + 文字讲清这个分怎么来的
 *     （频率 / 强度 / 体感 三维加权），逐肌群列分，并给出规范里的建议。
 *     点图与点卡头「说明 ›」进的是同一个抽屉。
 *
 * 与旧「本周容量」的区别：旧体系算的是**组数 vs MEV/MAV/MRV 地标**（只看量），
 * 练够分是**多维执行充分度**（频率 + 组数/次数/重量 + 体感，按目标加权），
 * 与《练够分 Lite》规范逐条对应（见 utils/trainingScore）。
 *
 * 力量记录一条都没有（近 42 天）时整卡隐藏，不占位置。
 */
const exStore = useExerciseStore()
const lib = useExerciseLibStore()
const nutrition = useNutritionStore()

const result = ref<TrainingScoreResult | null>(null)
const loaded = ref(false)
/** 近 42 天是否有力量记录：决定整卡是否出现（完全没有 = 这个评估指标对他没意义） */
const hasHistory = ref(false)
const sheetOpen = ref(false)
const catchupOpen = ref(false)

/** 热力档位：评估组分数投影到 39 个细肌群（同组同色） */
const heat = computed(() => (result.value ? groupLevelMap(result.value) : {}))

/** 悬停副标：「所属组 + 分数 + 档名」，比单个档名更有信息量 */
const heatRows = computed(() => (result.value ? groupTooltipMap(result.value) : {}))

/** 弱项：本周有记录但练够分 < 60（规范「不够」及以下） */
const weak = computed(() => (result.value ? weakGroups(result.value.groups) : []))

async function load(): Promise<void> {
  try {
    await lib.ensureLoaded()
    const sets = await sessionService.strengthRecentSets(42)
    hasHistory.value = sets.length > 0
    // 目标决定权重（增肌 30/50/20，减脂 35/35/30）—— 没有方案时按增肌
    await nutrition.loadProfile()
    result.value = computeTrainingScore({
      sets,
      library: lib.list,
      today: todayStr(),
      goal: nutrition.profile?.goal ?? null,
    })
  } catch (e) {
    console.warn('[score] 练够分统计失败', e)
    result.value = null
    hasHistory.value = false
  } finally {
    loaded.value = true
  }
}

onMounted(() => void load())

/** 逐组记录落库（结束保存 / 删除训练）后刷新 */
watch(
  () => exStore.strengthRev,
  () => void load(),
)

function openSheet(): void {
  sheetOpen.value = true
}
</script>

<template>
  <section v-if="!loaded || hasHistory" class="card">
    <header class="row between head">
      <div class="row hleft">
        <h2>肌肉热力图</h2>
        <span class="sub">练够分 · 每块肌肉本周练够了没有</span>
      </div>
      <!-- 「说明 ›」：与「点图上任意位置」进的是同一个抽屉（练够分说明）。
           两条路都留着 —— 按钮是**可发现**的入口（卡片上没有任何别的地方提示图能点），
           点图是**顺手**的入口（手指本来就在图上）。22px 高的胶囊不占版面。 -->
      <button class="detail row center" type="button" aria-label="查看练够分的计算说明与建议" @click="openSheet">
        说明 <ChevronRight :size="13" :stroke-width="2.6" />
      </button>
    </header>

    <!-- 结论行：左边一句话说清"要不要管"，右边平均分回答"整体多少分" -->
    <div v-if="result" class="concl row between">
      <p class="headline">{{ result.summary }}</p>
      <span v-if="result.trainedCount" class="avg num">
        <b>{{ result.average }}</b> 分
      </span>
    </div>

    <!-- 身体热力图：点图进练够分说明抽屉 -->
    <MuscleMap class="bodymap" :heat="heat" :heat-rows="heatRows" interactive @detail="openSheet" />

    <!-- 弱项加练：只在真有弱项时出现（没弱项时这个按钮点了也没内容可给） -->
    <button v-if="weak.length" class="catchup row center" type="button" @click="catchupOpen = true">
      <Sparkles :size="15" />
      弱项加练
      <small>· {{ weak.length }} 个肌群练得不够</small>
    </button>

    <RouterLink class="more row center" to="/sports/exercises">
      动作库<ChevronRight :size="14" />
    </RouterLink>

    <TrainingScoreSheet :open="sheetOpen" :result="result" @close="sheetOpen = false" />
    <MuscleCatchupSheet :open="catchupOpen" :weak="weak" @close="catchupOpen = false" />
  </section>
</template>

<style scoped>
/* 卡头：左「标题 + 副标」、右「说明 ›」。用 between 把胶囊顶到最右 ——
   副标是解释性的（"练够了没有"），不该把可点的入口挤在它后面。 */
.head {
  gap: 8px;
}

.hleft {
  gap: 8px;
  min-width: 0;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.sub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 「说明 ›」：与副标同一档字号，形态是胶囊（与画布卡的「详情 ›」同一套语汇）。
   色取 --accent-strong 而不是 --accent —— 后者压在 --surface-2 上实测只有
   4.27:1（亮）/ 3.82:1（暗），够不着 4.5；换成 strong 后是 5.54 / 5.31（量出来的）。 */
.detail {
  gap: 1px;
  flex: none;
  padding: 5px 10px 5px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.detail:active {
  opacity: 0.6;
}

.concl {
  margin-top: 8px;
  gap: 10px;
}

.headline {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
  min-width: 0;
}

/* 平均分：数字用标题档（它是这张卡的第二个焦点），单位小一号压在基线上 */
.avg {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.avg b {
  font-size: var(--fs-title3);
  font-weight: 700;
  color: var(--text-1);
  letter-spacing: -0.3px;
}

/* 热力图：三视图并排，给足宽度（84px 是 MuscleMap 里定死的单视图宽，
   3 视图 + 间距 ≈ 300px，430 视口下卡片内正好放得下） */
.bodymap {
  margin-top: 6px;
}

.catchup {
  gap: 6px;
  width: 100%;
  margin-top: 14px;
  padding: 11px 16px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.catchup small {
  font-weight: 500;
  opacity: 0.85;
}

.more {
  margin-top: 10px;
  justify-content: flex-end;
  gap: 2px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-exercise-deep);
}
</style>
