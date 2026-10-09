<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, Info, Lightbulb } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { SCORE_BANDS } from '@/config/muscles'
import { CONFIDENCE_LABEL, WEAK_LABEL, type GroupScore, type TrainingScoreResult } from '@/utils/trainingScore'

/**
 * 练够分说明抽屉（《练够分 Lite》V1.0）。
 *
 * 用户的问题是「这个 84 分是怎么来的、我该改什么」，所以这里分四段回答：
 *  1. **分数**：当前肌群的大字分数 + 档名 + 置信度 + 短板；
 *  2. **图表**：一条**数字节点链**（与重量建议抽屉同一语言）—— 频率/强度/体感三个节点，
 *     右侧是各自贡献分，说明行给「原始分 × 权重」；强度节点下再用三条细条展开
 *     组数/次数/重量（规范规定的 40/30/30 权重，条长 = 该项原始分完成度）；
 *     末尾「合计」节点把构成条挂上去：彩段 = 拿到的分，灰底 = 还没拿到的分。
 *  3. **建议**：规范第 10 节按最低分项给的话术，直说下一步做什么；
 *  4. **各肌群**：10 个评估组的分数与档位，点一行就切到那行的分解图。
 *     末尾「计算体系」可展开，逐条列出公式、权重表、数据来源与两处按本软件实况的适配。
 *
 * 全部数字来自 `computeTrainingScore`（纯函数）—— 本组件不重算任何口径，
 * 只做呈现；两处（卡片图例、本抽屉列表）的颜色也共用同一套令牌，不会漂。
 */
const props = defineProps<{
  open: boolean
  /** 练够分结果；null = 还没加载出来 */
  result: TrainingScoreResult | null
}>()

const emit = defineEmits<{ close: [] }>()

/* ---------- 选中的评估组 ---------- */

const selected = ref<string | null>(null)

/** 默认选中**练得最差的那个有记录的组** —— 打开抽屉时人最想知道的正是"先补哪块" */
function pickDefault(): void {
  const groups = props.result?.groups ?? []
  const trained = groups.filter((g) => !g.idle)
  selected.value = trained.length
    ? trained.reduce((a, b) => (b.score < a.score ? b : a)).group
    : (groups[0]?.group ?? null)
}

// 每次打开都重挑默认项（训练数据可能刚变），而不是只挑一次
watch(
  () => props.open,
  (o) => {
    if (o) pickDefault()
  },
)

/** 当前组：选中项不存在时取第一个有记录的组 */
const current = computed<GroupScore | null>(() => {
  const groups = props.result?.groups ?? []
  if (!groups.length) return null
  return groups.find((g) => g.group === selected.value) ?? groups.find((g) => !g.idle) ?? groups[0]!
})

/* ---------- 图表口径 ---------- */

/** 构成条的段宽（%）：贡献分本身就是「占 100 分的多少」，直接当百分比用 */
function pts(v: number): number {
  return Math.round(v * 10) / 10
}

/** 权重显示：0.3 → 30% */
function pctW(w: number): string {
  return `${Math.round(w * 100)}%`
}

/** 子项满额贡献分：0.4 → 40（满分 100 的原始分 × 权重） */
function subMax(w: number): number {
  return Math.round(w * 100)
}

/** 分数条宽（%），夹在 0..100 */
function barW(score: number): number {
  return Math.max(0, Math.min(100, score))
}

/** 三维构成（顺序即图表里的堆叠顺序）。Dimension 自带 key/label，这里只补配色类名 */
const dims = computed(() => {
  const g = current.value
  if (!g) return []
  return [
    { ...g.frequency, cls: 'dim-frequency' },
    { ...g.intensity, cls: 'dim-intensity' },
    { ...g.feeling, cls: 'dim-feeling' },
  ]
})

/** 强度分支：规范的 40% / 30% / 30% */
const subs = computed(() => {
  const g = current.value
  return g ? [g.setsScore, g.repsScore, g.weightScore] : []
})

/** 全部组按分数降序（列表用；高的在上面，与图上"越绿越多"一致） */
const groupRows = computed(() => {
  const groups = props.result?.groups ?? []
  return [...groups].sort((a, b) => b.score - a.score)
})

const showMethod = ref(false)

/** 置信度不合格时的提示（规范第 7 节原文口径） */
const lowConfidenceHint = computed(
  () => current.value?.confidence === 'low',
)
</script>

<template>
  <SheetModal :open="open" title="练够分说明" initial-snap="large" @close="emit('close')">
    <template v-if="current">
      <!-- ---------- 1. 分数 ---------- -->
      <header class="scard hero">
        <div class="hero-top row between">
          <span class="hero-name">{{ current.label }}</span>
          <span class="conf" :class="`conf-${current.confidence}`">
            置信度 {{ CONFIDENCE_LABEL[current.confidence] }}
          </span>
        </div>
        <div class="hero-score row">
          <b class="big num">{{ current.score }}</b>
          <span class="unit num">分</span>
          <span class="band" :class="`lv${current.level}`">{{ current.band }}</span>
        </div>
        <p class="hero-hint">{{ current.bandHint }}</p>
        <p v-if="lowConfidenceHint" class="conf-hint">
          当前分数参考性较低，建议再记录 2–3 次训练和体感。
        </p>
      </header>

      <!-- ---------- 2. 图表：100 分怎么拆出来的（数字节点链，与重量建议抽屉同一语言） ---------- -->
      <section class="scard">
        <div class="bhead row between">
          <h3>这 {{ current.score }} 分怎么来的</h3>
          <span class="btag">满分 100 = 运动充分</span>
        </div>

        <div
          class="chain"
          role="img"
          :aria-label="`练够分构成：频率 ${pts(current.frequency.contribution)} 分、强度 ${pts(current.intensity.contribution)} 分、体感 ${pts(current.feeling.contribution)} 分，共 ${current.score} 分`"
        >
          <div v-for="(d, i) in dims" :key="d.key" class="cnode">
            <i class="ndot num">{{ i + 1 }}</i>
            <div class="ntop row between">
              <span class="ntit"><i class="chip" :class="d.cls" />{{ d.label }}</span>
              <span class="nval num">{{ pts(d.contribution) }} 分</span>
            </div>
            <p class="ncap">{{ d.score }} × {{ pctW(d.weight) }} · {{ d.note }}</p>

            <!-- 强度分再展开三项（规范第 5 节：组数 40% / 次数 30% / 重量 30%）：
                 条长 = 该项原始分的完成度，右侧给「拿到 / 满额」的贡献分 -->
            <ul v-if="d.key === 'intensity'" class="subs">
              <li v-for="s in subs" :key="s.key" class="sub">
                <div class="subtop row between">
                  <span class="sname">{{ s.label }}</span>
                  <span class="scal num">{{ pts(s.contribution) }} / {{ subMax(s.weight) }} 分</span>
                </div>
                <span class="subtrack"><i class="subfill" :style="{ '--p': `${s.score}%` }" /></span>
              </li>
            </ul>
            <p v-if="d.key === 'intensity'" class="ncap sub-note">
              强度分 = 组数 × 40% + 次数 × 30% + 重量 × 30%
            </p>
          </div>

          <!-- 合计节点：构成条挂在这 —— 彩段 = 三个维度实际贡献的分，灰底 = 还没拿到的分 -->
          <div class="cnode final">
            <i class="ndot num">4</i>
            <div class="ntop row between">
              <span class="ntit">合计 = 练够分</span>
              <span class="nval final num">{{ current.score }} 分</span>
            </div>
            <div class="comp">
              <span
                v-for="d in dims"
                :key="d.key"
                class="seg"
                :class="d.cls"
                :style="{ width: `${pts(d.contribution)}%` }"
              />
            </div>
            <p class="ncap">彩段是各维度实际拿到的分，灰底是还没拿到的分。</p>
          </div>
        </div>
      </section>

      <!-- ---------- 3. 建议 ---------- -->
      <section class="scard">
        <div class="bhead row between">
          <h3>建议</h3>
          <span class="btag">短板：{{ WEAK_LABEL[current.weakest] }}</span>
        </div>
        <ul class="advice">
          <li v-for="(a, i) in current.advice" :key="i" class="adv row">
            <i class="advicon"><Lightbulb :size="14" /></i>
            <span>{{ a }}</span>
          </li>
        </ul>
      </section>

      <!-- ---------- 4. 各肌群 ---------- -->
      <section class="scard">
        <div class="bhead row between">
          <h3>各肌群练够分</h3>
          <span class="btag">点一行看它的分解</span>
        </div>
        <ul class="groups">
          <li v-for="g in groupRows" :key="g.group">
            <button
              class="grow row"
              type="button"
              :class="{ on: g.group === current.group }"
              :aria-pressed="g.group === current.group"
              @click="selected = g.group"
            >
              <i class="gdot" :class="`lv${g.level}`" />
              <div class="gmid flex-1">
                <div class="gline row between">
                  <span class="gname">{{ g.label }}</span>
                  <span class="gband">{{ g.idle ? '未练' : g.band }}</span>
                </div>
                <span class="gtrack"><i class="gbar" :class="`lv${g.level}`" :style="{ '--p': `${barW(g.score)}%` }" /></span>
              </div>
              <span class="gscore num">{{ g.idle ? '—' : g.score }}</span>
            </button>
          </li>
        </ul>
      </section>

      <!-- ---------- 5. 计算体系（可展开） ---------- -->
      <section class="scard">
        <button class="mhead row between" type="button" :aria-expanded="showMethod" @click="showMethod = !showMethod">
          <span class="row mtit">
            <i class="micon"><Info :size="14" /></i>
            <h3>计算体系</h3>
          </span>
          <ChevronDown :size="16" class="chev" :class="{ open: showMethod }" />
        </button>

        <div v-if="showMethod" class="method">
          <p class="mtext">
            练够分 = 频率分 × 频率权重 + 强度分 × 强度权重 + 体感分 × 体感权重，封顶 100、四舍五入。
            强度分 = 组数分 × 40% + 次数分 × 30% + 重量分 × 30%。
          </p>

          <!-- 权重表：当前目标那一行高亮，另两行给对照 -->
          <table class="wtable">
            <thead>
              <tr><th>目标</th><th>频率</th><th>强度</th><th>体感</th></tr>
            </thead>
            <tbody>
              <tr :class="{ on: result?.goal === 'bulk' }">
                <td>增肌</td><td>30%</td><td>50%</td><td>20%</td>
              </tr>
              <tr :class="{ on: result?.goal === 'cut' }">
                <td>减脂</td><td>35%</td><td>35%</td><td>30%</td>
              </tr>
            </tbody>
          </table>
          <p class="mnote">当前按「{{ result?.goal === 'cut' ? '减脂' : '增肌' }}」权重计算（取自你的健康方案目标）。</p>

          <!-- 分档阶梯：当前档高亮 -->
          <h4 class="msub">分档</h4>
          <ul class="bands">
            <li v-for="b in SCORE_BANDS" :key="b.label" class="bandrow" :class="{ on: b.label === current.band }">
              <span class="bmin num">{{ b.min }}{{ b.min === 100 ? '' : '+' }}</span>
              <span class="blabel">{{ b.label }}</span>
              <span class="bhint">{{ b.hint }}</span>
            </li>
          </ul>

          <h4 class="msub">数据来源</h4>
          <ul class="msrc">
            <li><b>频率 / 强度</b>：力量训练的逐组记录（组数、重量、每组次数），最近 7 天滚动。</li>
            <li><b>体感</b>：训练页的「今日状态自评」（很好/不错 → 良好，一般 → 一般，疲惫/很差 → 差）；没自评时按规范默认 60 分并降低置信度。</li>
            <li><b>目标</b>：健康方案里的目标（增肌 / 减脂），决定上面那张权重表用哪一行。</li>
          </ul>

          <h4 class="msub">两处按本软件实况的适配</h4>
          <ul class="msrc">
            <li>
              <b>组数/次数按肌群激活档位折算</b>：主攻记 1 组、辅助 0.5 组、稳定 0.25 组。
              规范假设「一次训练只针对一个肌群」，而一堂课会同时刺激多块肌肉 ——
              不折算的话，一组卧推会把胸、三头、前束各记满 1 组。
            </li>
            <li>
              <b>频率只在辅助及以上才计一次</b>：稳定肌群（复合动作里打酱油的腹直肌）
              不该算作「今天专门练过核心」。
            </li>
            <li><b>评估单位是 10 个肌群</b>（胸/背/肩/二头/三头/臀/腿前/腿后/小腿/核心），热力图上同组同色。</li>
          </ul>

          <p class="mdisclaim">
            练够分衡量的是「训练执行充分度」，不是生理恢复或医疗诊断。有明确关节、肌腱疼痛或麻木刺痛，
            应停止相关动作并咨询医生或康复师；数据越完整，分数越可信。
          </p>
        </div>
      </section>
    </template>

    <p v-else class="empty">还没有可评估的训练记录。</p>
  </SheetModal>
</template>

<style scoped>
/* ---------- 白卡：抽屉每一段内容的载体 ----------
   抽屉在极致档本身就是玻璃（面板底只有 0.66 的白），正文直接铺上去会把背后的页面
   透出来 —— 顶部那圈灰带、分数与图表跟着背景浮动都是这么来的。每段内容因此落在
   一张白卡上把正文压住；材质与档位覆盖全在令牌里（tokens.css 的 --sheet-card-*），
   组件只负责用：档位升级这里一行都不用改，也不会挂上 svg 折射。 */
.scard {
  padding: 16px;
  border-radius: var(--radius-xl);
  background: var(--sheet-card-fill);
  box-shadow: var(--sheet-card-shadow);
}

.scard + .scard {
  margin-top: 12px;
}

/* 首张卡与抽屉标题之间留一点呼吸（body 自身只有 4px 顶内边距） */
.scard:first-child {
  margin-top: 6px;
}

/* ---------- 1. 分数 ---------- */
.hero-name {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

/* 置信度：高/中/低三档只换色不换形 —— 它是"这个分有多可信"的注脚，不该抢主分 */
.conf {
  padding: 3px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
  background: var(--surface-2);
}

.conf-high {
  color: var(--c-exercise-deep);
}

.conf-low {
  color: var(--warn-strong);
}

.hero-score {
  margin-top: 6px;
  align-items: baseline;
  gap: 8px;
}

.big {
  font-size: 44px;
  font-weight: 800;
  letter-spacing: -1.5px;
  color: var(--text-1);
  line-height: 1.05;
}

.unit {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-3);
}

.band {
  margin-left: 2px;
  padding: 4px 11px;
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-1);
  background: var(--surface-2);
}

.hero-hint {
  margin-top: 6px;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.conf-hint {
  margin-top: 6px;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--warn-strong);
}

/* ---------- 通用块 ----------
   段落之间原本靠一条横线分隔；现在每段是一张白卡，间隔与分层都交给 .scard。 */

.bhead h3 {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.btag {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ---------- 2. 构成条 ---------- */
/* 条底 = "还没拿到的分"；三段彩色 = 三个维度实际贡献的分。总宽恒为满分的 100 分，
   所以"条还差多少"与"分还差多少"是同一个数，不用再解释一遍。 */
.comp {
  display: flex;
  height: 16px;
  margin-top: 12px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--surface-2);
}

.seg {
  height: 100%;
  /* 共轨堆叠构成条：只保留 flex width 不换结构，时长降一档跟上节奏 */
  transition: width var(--dur-base) var(--ease-standard);
}

/* 三段之间留一道极细的缝：段色都偏饱和，紧贴会糊成一段读不出边界。
   缝色取卡片自己的底（极致档卡片是 0.92 白，写死 --surface 这条缝就没了） */
.seg + .seg {
  box-shadow: -1px 0 0 0 var(--sheet-card-fill);
}

.dim-frequency {
  background: var(--c-balance);
}

.dim-intensity {
  background: var(--c-exercise-deep);
}

.dim-feeling {
  background: var(--accent-strong);
}

/* ---------- 节点链：与重量建议抽屉（WeightAdviceSheet）同一套视觉语言 ----------
   三个维度各是一个彩色节点，点色 = 构成条的段色，图与链同色呼应；末尾合计节点
   把构成条挂上去当结论。 */
.chain {
  margin-top: 14px;
}

.cnode {
  position: relative;
  padding: 0 0 18px 34px;
}

/* 节点间连线：最后一个节点不画 */
.cnode::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 24px;
  bottom: 2px;
  width: 2px;
  border-radius: 1px;
  background: var(--line);
}

.cnode:last-child {
  padding-bottom: 2px;
}

.cnode:last-child::before {
  display: none;
}

.ndot {
  position: absolute;
  left: 0;
  top: 0;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
}

/* 终点节点：合计是整条链的结论，绿底白字（与重量建议抽屉的「今天建议」同款） */
.cnode.final .ndot {
  background: var(--c-exercise-deep);
  color: #fff;
}

/* 标题前的小色点：把节点和构成条的段色对上号（点本身回归编号，不再承担配色） */
.chip {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  vertical-align: 1px;
}

.ntop {
  align-items: baseline;
  gap: 8px;
}

.ntit {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
}

.nval {
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
  white-space: nowrap;
}

.nval.final {
  font-size: var(--fs-title3);
  color: var(--c-exercise-deep);
}

.ncap {
  margin-top: 2px;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-3);
}

/* 强度子项：与重量建议抽屉的因子条同款 —— 行内标签+右侧「拿到/满额」，下面一条细条，
   条长就是该项原始分的完成度，不再用左框线列表 */
.subs {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.subtop {
  align-items: baseline;
  gap: 8px;
}

.sub .sname {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.sub .scal {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.subtrack {
  display: block;
  height: 4px;
  margin-top: 3px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.subfill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--c-exercise-deep);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
}

.sub-note {
  margin-top: 6px;
}

/* ---------- 3. 建议 ---------- */
.advice {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.adv {
  gap: 8px;
  font-size: var(--fs-footnote);
  line-height: 1.6;
  color: var(--text-1);
}

.advicon {
  width: 22px;
  height: 22px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--warn-soft);
  color: var(--warn-strong);
}

/* ---------- 4. 各肌群 ---------- */
.groups {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
}

.grow {
  width: 100%;
  gap: 10px;
  padding: 11px 8px;
  text-align: left;
  border-radius: var(--radius-m);
  transition: background var(--dur-fast) var(--ease-standard);
}

.grow.on {
  background: var(--surface-2);
}

.grow:active {
  opacity: 0.65;
}

.gmid {
  min-width: 0;
}

.gline {
  gap: 8px;
}

.gname {
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
}

.gband {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 分数条：与图上 fill 同源（档位类名 lv0–lv4），所以"条短"和"图上那片红"是同一件事 */
.gtrack {
  display: block;
  height: 6px;
  margin-top: 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.gbar {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.gdot {
  width: 12px;
  height: 12px;
  flex: none;
  margin-top: 3px;
  border-radius: 50%;
}

.gscore {
  flex: none;
  width: 30px;
  text-align: right;
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

/* ---------- 档位实色（低 → 高；0 = 未练）。与 MuscleMap 的图例同源，不带 alpha */
.lv0 {
  background: var(--text-3);
}

.lv1 {
  background: var(--danger);
}

.lv2 {
  background: var(--warn);
}

.lv3 {
  background: var(--heat-mid);
}

.lv4 {
  background: var(--c-exercise);
}

/* ---------- 5. 计算体系 ---------- */
.mhead {
  width: 100%;
  padding: 2px 2px 6px;
  text-align: left;
}

.mtit {
  gap: 7px;
}

.mhead h3 {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.micon {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
}

.chev {
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.chev.open {
  transform: rotate(180deg);
}

.method {
  padding-top: 4px;
}

.mtext {
  font-size: var(--fs-footnote);
  line-height: 1.7;
  color: var(--text-2);
}

.wtable {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-size: var(--fs-caption);
}

.wtable th,
.wtable td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 0.5px solid var(--line);
  color: var(--text-2);
}

.wtable th {
  font-weight: 600;
  color: var(--text-3);
}

/* 当前目标那一行加重：权重表是"我该看哪一行"的问题，不是两张都要读 */
.wtable tr.on td {
  font-weight: 700;
  color: var(--text-1);
  background: var(--surface-2);
}

.mnote {
  margin-top: 6px;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--text-3);
}

.msub {
  margin-top: 16px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
}

.bands {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
}

.bandrow {
  display: grid;
  grid-template-columns: 42px 62px 1fr;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-size: var(--fs-caption);
}

.bandrow.on {
  background: var(--surface-2);
}

.bmin {
  font-weight: 700;
  color: var(--text-2);
}

.blabel {
  font-weight: 600;
  color: var(--text-1);
}

.bhint {
  color: var(--text-3);
}

.msrc {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: var(--fs-caption);
  line-height: 1.7;
  color: var(--text-2);
}

.msrc b {
  color: var(--text-1);
}

.mdisclaim {
  margin-top: 14px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--text-3);
}

.empty {
  padding: 24px 2px;
  text-align: center;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}
</style>
