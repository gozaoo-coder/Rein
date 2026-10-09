<script setup lang="ts">
import { computed, ref } from 'vue'
import { CalendarDays, ChevronRight, Dumbbell, House, Plus, SlidersHorizontal, Sparkles, User } from 'lucide-vue-next'

import GlassSurface from '@/components/common/GlassSurface.vue'
import GlassDockAssembly from '@/components/common/GlassDockAssembly.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import GlassTunerSheet from '@/components/perf/GlassTunerSheet.vue'
import { usePressGlow } from '@/composables/usePressGlow'
import { motionEffective, motionLevel, motionRich, setMotionLevel, MOTION_LEVELS, type MotionLevel } from '@/system/motion'
import { PERF_MODES, perfMode, setPerfMode, supportsSvgBackdrop, type PerfMode } from '@/system/perf'

/**
 * 画质预览（三级页，入口在「设置 › 性能」）：**超高档的液态玻璃长什么样**。
 *
 * 这一页要回答三个问题，从上到下就是这个顺序：
 *   1. 这一档在我这台设备上到底生效了吗（能力探测 + 当前档位，如实说）
 *   2. 两块基本件好不好看：仅图标按钮（正圆）与图标 + 文字按钮（胶囊）
 *   3. 一整套底部栏装起来是什么样（左圆钮 + 中间药丸 + 右圆钮，三块玻璃各留缝并列）
 *   4. 不满意就**就地调**：台下的入口拉开参数面板 —— 管线上的 12 个数字摊开成
 *      滑杆 + 可点输入的数值（system/glassParams，改的是全局那份，定稿写回 GLASS_DEFAULTS）
 *
 * 为什么不摆在一张白卡上：液态玻璃折射的是**它背后的东西**，背后越热闹它才越有得看。
 * 但"热闹"不等于"花"—— 上一版拿五段满饱和撞色 + 30% 白斜纹当壁纸，玻璃边缘那道折射
 * 反而被背景的高频噪声淹了；而且浅雾白玻璃压在高饱和底色上时，页签文字（--text-3）
 * 合成起来只有 ~1.4:1，读不出来（smell report 的 HIGH）。
 *
 * 所以这一版把台子改成**暗场**：壁纸是应用自己的暗场材料（--hero-*，与跑步页、
 * 训练详情同一套），亮暗色两种主题下都是同一块暗底 ——
 *   · 玻璃背后是暗的，前景就永远是浅色（--hero-text*），与主题无关，对比度不再"看运气"；
 *   · 单光源（一道柔光带 + 同色相族的两团光晕）代替五段撞色，色相噪声收掉；
 *   · 只留一层 1px 细格当量尺：位移错开几个像素一眼可见，而不是靠斜纹"糊"出高频。
 * 台上三件按「状态 / 基本件 / 组件装配」三层陈列，各自占满整行 —— 读成展台，而不是
 * 三块玻璃漂在中间。玻璃参数仍一律走组件默认（那套出厂数按 54~58px 的 UI 尺寸标定过，
 * 见 GlassSurface 头注释；现在**可调**，见 system/glassParams），
 * 调用处只给尺寸、圆角与"压在暗底上"这一个语义（tint="dark"）。
 */
const mode = computed({
  get: () => perfMode.value as string,
  // 与设置页同一条白名单：分段控件的值也只认清单里有的档
  set: (v: string) => {
    if (PERF_MODES.some((m) => m.value === v)) setPerfMode(v as PerfMode)
  },
})

const PERF_OPTIONS = PERF_MODES.map(({ value, label }) => ({ value, label }))

/** 当前档位下这块玻璃的真实状态：能力不足就明说，别让人对着退化结果猜 */
const glassState = computed(() => {
  const m = perfMode.value
  if (m === 'low') return { tone: 'warn', text: '流畅档：玻璃顶成实底，不做折射' }
  // 高画质起玻璃已铺满（卡片 / 抽屉 / 菜单 / 操作面板 / 页头圆钮），差的只有折射
  if (m === 'high') {
    return { tone: 'idle', text: '高画质 · 全局玻璃（毛玻璃，无折射）· 切到「超高」或「极致」即开折射' }
  }
  // 超高 / 极致：折射要求内核认得 url() 当背景滤镜用
  if (!supportsSvgBackdrop()) {
    return { tone: 'warn', text: '本机内核不支持折射：折射退化为普通毛玻璃，全局玻璃照旧' }
  }
  // 折射开着时，把**实际走的链**报出来：这一页要能验证两档到底换了什么，
  // 而不是只看档位标签。超高与极致共用同一条塌缩链，差别只在材质深浅。
  return m === 'extreme'
    ? { tone: 'on', text: '极致 · 折射已开启 · 塌缩管线（3 个原语）+ 全局玻璃' }
    : { tone: 'on', text: '超高 · 折射已开启 · 塌缩管线（3 个原语）' }
})

/** 底部栏的三项（与应用里的 Dock 同名同图标，方便对照观感） */
const TABS = [
  { id: 'home', label: '主页', icon: House },
  { id: 'sports', label: '运动', icon: Dumbbell },
  { id: 'me', label: '我', icon: User },
]
const previewDock = {
  left: { id: 'schedule', label: '课表', icon: CalendarDays },
  right: { id: 'ai', label: 'AI', icon: Sparkles },
}
const active = ref('sports')

/** 参数调节面板（液态玻璃管线上的 12 个数字）：入口在标本台正下方 */
const tunerOpen = ref(false)

/** 标本台的按压定向光晕：与真实 Dock 同一套（丰富档下按页签会跟着手指亮） */
const dockRowEl = ref<HTMLElement | null>(null)
usePressGlow(dockRowEl, '.dock-tab, .dock-slot')

/* ---------- 动效档位（与设置页共用一份清单） ---------- */
const MOTION_OPTIONS = MOTION_LEVELS.map(({ value, label }) => ({ value, label }))

const motionMode = computed({
  get: () => motionLevel.value as string,
  set: (v: string) => {
    if (MOTION_LEVELS.some((m) => m.value === v)) setMotionLevel(v as MotionLevel)
  },
})

/** 如实报**实际生效**的那一档：被系统减弱动效、或被掉帧压回默认时，
 *  用户选的那一档并没有生效 —— 与 glassState 同一条原则 */
const motionNote = computed(() => {
  if (motionEffective.value !== motionLevel.value) {
    return motionEffective.value === 'off'
      ? '系统已要求「减弱动效」，当前按「关闭」执行'
      : '掉帧降级中，已退回「默认」'
  }
  return MOTION_LEVELS.find((m) => m.value === motionLevel.value)?.hint ?? ''
})

/** 让台上的底栏标本走一格：换索引就是一次「活动底平移 + 形变」，
 *  丰富档下还带一次融合（按下页签同样会触发）。 */
function replaySpecimen(): void {
  const i = Math.max(0, TABS.findIndex((t) => t.id === active.value))
  const next = TABS[(i + 1) % TABS.length]
  if (next) active.value = next.id
}

/** 仅图标按钮的边长（与应用里主按钮的 54 一致），正圆取半高 */
const ICON_BTN = 54
</script>

<template>
  <div class="page">
    <PageHeader title="画质预览" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 暗场标本台：一整幅壁纸 + 三层陈列。台子铺到页面两侧边缘，读成一整块暗场 -->
    <section class="bench" aria-label="液态玻璃示例">
      <!-- 壁纸：横向可拖（玻璃拖过它才看得见边缘色散）。纯装饰，读屏不必知道 -->
      <div class="strip" data-rubber-self aria-hidden="true">
        <div class="plane">
          <span class="beam" />
          <span class="glow glow-a" />
          <span class="glow glow-b" />
          <span class="grid" />
        </div>
      </div>

      <div class="rails">
        <!-- ① 读数：这一档此刻的真实状态（开了 / 退化了 / 内核不支持，各说各的） -->
        <p class="plaque" :class="glassState.tone" role="status">
          <span class="dot" />
          {{ glassState.text }}
        </p>

        <!-- ② 基本件：仅图标按钮（高 == 宽、正圆）与图标 + 文字按钮（同高的胶囊）。
                圆角从高度推出来（正圆取 50%，胶囊取半高），不再各写一遍魔数 -->
        <div class="parts stage-dark">
          <GlassSurface :width="ICON_BTN" :height="ICON_BTN" border-radius="50%" tint="dark">
            <button type="button" class="ibtn" aria-label="仅图标按钮示例">
              <Plus :size="22" :stroke-width="2.2" />
            </button>
          </GlassSurface>

          <GlassSurface :width="156" :height="ICON_BTN" :border-radius="ICON_BTN / 2" tint="dark">
            <button type="button" class="tbtn">
              <Sparkles :size="18" />
              <span>开始训练</span>
            </button>
          </GlassSurface>
        </div>

        <!-- ③ 组件装配：直接复用生产 Dock 的共享玻璃装配组件 -->
        <div ref="dockRowEl" class="dockrow">
          <GlassDockAssembly
            :items="TABS"
            :active="active"
            :left="previewDock.left"
            :right="previewDock.right"
            :goo="motionRich"
          >
            <template #left>
              <button type="button" class="dock-slot glow-layer" aria-label="课表（自定义落点示例）">
                <CalendarDays :size="21" />
                <span>课表</span>
              </button>
            </template>
            <template #tab="{ item, active: itemActive }">
              <button
                type="button"
                class="dock-tab glow-layer"
                :class="{ active: itemActive }"
                :aria-pressed="itemActive"
                @click="active = item.id"
              >
                <component :is="item.icon" :size="22" :stroke-width="itemActive ? 2.4 : 1.9" />
                <span>{{ item.label }}</span>
              </button>
            </template>
            <template #right>
              <button type="button" class="dock-slot glow-layer" aria-label="AI">
                <Sparkles :size="21" />
                <span>AI</span>
              </button>
            </template>
          </GlassDockAssembly>
        </div>
      </div>
    </section>

    <!-- 参数调节入口：紧贴标本台 —— 调的就是刚才看到的那几块玻璃。
         面板里改动即时生效（改的是全局那份可调参数），台上三件跟着一起变 -->
    <button type="button" class="tuner" @click="tunerOpen = true">
      <SlidersHorizontal :size="18" />
      <span class="tuner-txt">
        <b>液态玻璃参数调节</b>
        <small class="t-3">折射位移 · 边缘厚度 · 底色浓度…共 12 项，拖动即时生效</small>
      </span>
      <ChevronRight :size="18" class="chev" />
    </button>

    <!-- 桌面栅格：壳层不对宽形态页面做任何栅格，这一层 d-grid 负责把两块
         「档位」并排 —— 手机端它只是个普通 div，块流与卡片间距都不变 -->
    <div class="d-grid perf-panels">
    <section class="card">
      <h2 class="ctitle">档位</h2>

      <SegmentedControl v-model="mode" class="perfseg" :options="PERF_OPTIONS" />

      <!-- 三组「量名 × 数值」各自 nowrap：在窄卡里折行不能把量名和数值拆开 -->
      <p class="spec t-3">
        台上三件的尺寸：<span class="nw">正圆按钮 54 × 54</span> ·
        <span class="nw">胶囊按钮 156 × 54</span> ·
        <span class="nw">底栏高 58</span>（与主按钮同高）
      </p>

      <ul class="modes">
        <li v-for="m in PERF_MODES" :key="m.value" :class="{ on: m.value === perfMode }">
          <b>{{ m.label }}</b>
          <span class="t-3">{{ m.hint }}</span>
        </li>
      </ul>

      <p class="pnote t-3">
        壁纸可以横向拖：玻璃折射的是它背后的东西，拖起来才看得见边缘那道位移。
        内核不支持 <code>backdrop-filter: url()</code>（Safari / Firefox）时自动退化成普通毛玻璃，
        不会留下空白。
      </p>
      <p class="pnote t-3">
        四档都是手动钉死的固定档，不会在后台自己切。「超高」与「极致」的折射走同一条
        <b>塌缩管线</b>：把上游那套三通道位移 + screen 复合换成等价的单次位移
        （出厂参数下那套复合是恒等变换，逐像素一致），10 个原语降到 3 个，全程序只有这一条链。
        两档的差别只在<b>材质</b>：「极致」的光学层更深一档，并把玻璃铺到卡片、抽屉、菜单、
        操作面板与快捷磁贴，材质分层对齐苹果的 Liquid Glass 规范。台上读数会报出实际走的是哪条链。
        手机上若觉得发烫，切回「高画质」或「流畅」即可。
      </p>
    </section>

    <!-- 动效：与画质正交的另一档。上面的标本跟着它变 —— 差别在台上直接看得见 -->
    <section class="card">
      <h2 class="ctitle">动效</h2>

      <SegmentedControl v-model="motionMode" class="perfseg" :options="MOTION_OPTIONS" />

      <p class="spec t-3">{{ motionNote }}</p>

      <button type="button" class="replay" @click="replaySpecimen">试一下 · 让上面的底栏走一格</button>

      <p class="pnote t-3">
        「默认」就是现在这一套，不加任何装饰。「丰富」在它之上再加液态玻璃的动作：活动底会从
        按下的那一点长出一颗小球与它融合（抬手分裂），位移途中拉宽压扁、收窄拉高 ——
        苹果那条「由力而非速度决定的形变」；抽屉与菜单改成透镜式进出；页头随滚动收缩与还原。
        台上直接点页签就能看见，不必来回切档。
      </p>
      <p class="pnote t-3">
        动效与画质互不影响：这一页管的是「玻璃画不画得出来」，动效管的是「界面要不要动」。
        掉帧降级时丰富档会自动退回默认，不会一边掉帧一边加合成。
      </p>
    </section>

    </div>

    <!-- 参数调节面板：自带暗场预览，改的就是全局那份可调参数（system/glassParams） -->
    <GlassTunerSheet :open="tunerOpen" @close="tunerOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 暗场标本台 ---------- */
.bench {
  position: relative;
  margin: 4px calc(var(--page-pad-x) * -1) 14px;
  overflow: hidden;
  background: var(--hero-bg);
}

/* 台内换一套玻璃材质：class 上的 .stage-dark（base.css）—— 暗底上的玻璃按应用在
   暗场的做法压暗（HUD 芯片材质），受光边换中性白，前景因此永远是浅色（--hero-text*），
   与当前主题无关。**参数面板的预览台用的是同一份**，两处不再各抄一遍；
   弱档的实底退化也在那份里（html[data-perf='low'] .stage-dark）。
   **只加在「基本件」这一行上**（读数胶囊直接用 --hero-chip-*，不走玻璃令牌）：
   底下的底栏标本要与真实 Dock 一模一样，套上这套暗场令牌就比真实 Dock 暗一档 ——
   它走应用自己的 --glass-* 与前景令牌（见 base.css 的 .dock-* 一份定义）。 */

/* 「减弱透明度」档：组件的退化分支会把玻璃顶成 --surface（亮色下是白的），
   而台上这一行的前景是浅色 —— 会撞成白字白底。台内把「表面」这个词换成暗场底色，
   退化分支于是落回同一块暗玻璃，前景不用跟着变。 */
@media (prefers-reduced-transparency: reduce) {
  .parts {
    --surface: var(--hero-bg);
    --line-strong: var(--hero-chip-line);
  }

  /* 折射分支要单独压：白雾底与折射滤镜都是**内联样式**，媒体查询在组件里够不着它。
      系统既然要求了「减弱透明度」，台上就不该还有一层半透明玻璃在折射。
      （底栏标本不压：它要跟真实 Dock 一样走组件的退化分支） */
  .parts :deep(.glass) {
    background: var(--hero-bg) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

.strip {
  position: absolute;
  inset: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.plane {
  position: relative;
  width: 240%;
  height: 100%;
}

.beam,
.glow,
.grid {
  position: absolute;
  pointer-events: none;
}

/* 单光源：一道斜掠的柔光带 */
.beam {
  inset: -20% -8%;
  background: linear-gradient(
    112deg,
    transparent 16%,
    color-mix(in srgb, var(--hero-text) 7%, transparent) 44%,
    transparent 68%
  );
}

/* 同色相族的两团光晕（运动绿 → 均衡青，应用的领域色）：慢慢漂，
   不用动手也能看见玻璃边缘在动 */
.glow {
  border-radius: 50%;
}

.glow-a {
  top: -30%;
  left: -8%;
  width: 88%;
  height: 140%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--c-exercise) 46%, transparent), transparent);
  animation: drift-a 26s ease-in-out infinite alternate;
}

.glow-b {
  right: 4%;
  bottom: -32%;
  width: 66%;
  height: 130%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--c-balance) 30%, transparent), transparent);
  animation: drift-b 34s ease-in-out infinite alternate;
}

/* 量尺：1px 细格（--hero-grid 只有 3.5% 白）。平缓的光晕负责好看，
   这层细格负责"看得见位移" —— 玻璃把背后的像素挪开几像素，格线一眼就错开了 */
.grid {
  inset: 0;
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 12px 12px;
}

@keyframes drift-a {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(6%, 5%, 0);
  }
}

@keyframes drift-b {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(-7%, -6%, 0);
  }
}

/* 三层陈列：状态 / 基本件 / 组件装配。整行铺满，不再居中漂浮 */
.rails {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 18px var(--page-pad-x) 20px;
  pointer-events: none; /* 空处留给壁纸拖动 */
}

.parts,
.dockrow {
  pointer-events: auto;
}

/* 读数：与跑步页 HUD 同一套芯片材质；文字如实反映状态，色点只是第二通道 */
.plaque {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--hero-chip-line);
  border-radius: var(--radius-full);
  background: var(--hero-chip-bg);
  color: var(--hero-text);
  font-size: var(--fs-caption);
  font-weight: 600;
  line-height: 1.5;
}

.dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hero-text-dim);
}

.plaque.on .dot {
  background: var(--c-exercise);
}

.plaque.warn .dot {
  background: var(--warn);
}

.plaque.idle {
  color: var(--hero-text-dim);
}

.parts {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 按钮本体透明：玻璃由 GlassSurface 画，按钮只负责命中区与前景 */
.ibtn,
.tbtn {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: inherit;
  color: var(--hero-text);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.ibtn:active,
.tbtn:active {
  transform: scale(0.94);
}

.tbtn {
  font-size: var(--fs-callout);
  font-weight: 600;
}

/* 底栏标本：三块玻璃的尺寸关系与页签前景在 base.css 的 .dock-block / .dock-tab /
   .dock-slot（与真实 Dock 共用一份，见那里的注释）—— 这里只管这一行的排版 */
.dockrow {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---------- 参数调节入口 ---------- */
.tuner {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 13px 16px;
  border-radius: var(--radius-xl);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
}

.tuner:active {
  background: var(--surface-2);
}

.tuner-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tuner-txt b {
  font-size: var(--fs-callout);
  font-weight: 600;
}

.tuner-txt small {
  font-size: var(--fs-caption);
}

.chev {
  flex: none;
  color: var(--text-3);
}

/* ---------- 档位 ---------- */
.ctitle {
  font-size: var(--fs-headline);
  font-weight: 700;
}

.perfseg {
  margin-top: 10px;
}

/* 「试一下」：让台上那台底栏走一格 —— 「丰富」这一档有没有生效，
   看一眼比读说明快。样式与 .tuner 同族（一块次级实底、无影子） */
.replay {
  width: 100%;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: 600;
  text-align: center;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.replay:active {
  background: var(--line-strong);
}

.spec {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.spec .nw {
  white-space: nowrap;
}

.modes {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.modes li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-caption);
}

.modes li b {
  flex: none;
  /* 要放得下最长的档名「高画质」（3 个全角字 × 14px）+ 余量：列宽固定，
     右边的说明才对得齐 */
  width: 56px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

.modes li.on b {
  color: var(--accent);
}

.pnote {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.pnote code {
  padding: 0 3px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-micro);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   这一页是宽形态（desk: 'wide'），构图自负。
   · 整页收到 --desk-wide：标本台与两个档位卡都不该在 2K 屏上摊成一条；
   · 标本台内部改横排：读数在左、两块基本件靠右，装配好的底栏独占下一行 ——
     手机上是三层竖着叠，左右两侧全是空的暗场；
   · 两块「档位」并排（画质 / 动效是一对正交的档），对比着看才看得出区别。
   ============================================================ */
.desk-main .page {
  max-width: var(--desk-wide);
  margin-inline: auto;
}

.desk-main .rails {
  display: grid;
  grid-template-columns: var(--desk-aside) minmax(0, 1fr);
  align-items: center;
  column-gap: var(--desk-gap);
}

/* 读数胶囊原本靠 align-self 收成内容宽；换成栅格后轴的语义变了，补一句同义的 */
.desk-main .plaque {
  justify-self: start;
}

/* 两块基本件是右手边那两枚玻璃：靠右站，与左边的读数形成一条展台横轴 */
.desk-main .parts {
  justify-self: end;
}

/* 装配好的底栏要整宽 —— 它要按真实 Dock 的比例铺开，塞进 320px 就走形了 */
.desk-main .dockrow {
  grid-column: 1 / -1;
}

/* 两块「档位」并排：阅读顺序不变（先画质后动效），只是换成了两栏 */
.desk-main .perf-panels {
  align-items: start;
}
</style>
