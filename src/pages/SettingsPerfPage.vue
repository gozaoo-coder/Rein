<script setup lang="ts">
import { computed, ref } from 'vue'
import { CalendarDays, ChevronRight, Dumbbell, House, Plus, SlidersHorizontal, Sparkles, User } from 'lucide-vue-next'

import GlassSurface from '@/components/common/GlassSurface.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import GlassTunerSheet from '@/components/perf/GlassTunerSheet.vue'
import { PERF_MODES, liquidGlass, perfDegraded, perfMode, setPerfMode, supportsSvgBackdrop, type PerfMode } from '@/system/perf'

/**
 * 画质预览（三级页，入口在「设置 › 性能」）：**超高档的液态玻璃长什么样**。
 *
 * 这一页要回答三个问题，从上到下就是这个顺序：
 *   1. 这一档在我这台设备上到底生效了吗（能力探测 + 当前档位，如实说）
 *   2. 两块基本件好不好看：仅图标按钮（正圆）与图标 + 文字按钮（胶囊）
 *   3. 一整套底部栏装起来是什么样（左圆钮 + 中间药丸 + 右圆钮，三块玻璃各留缝并列）
 *   4. 不满意就**就地调**：台下的入口拉开参数面板 —— 管线上的 11 个数字摊开成
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
  if (liquidGlass.value) return { tone: 'on', text: '超高 · 折射已开启' }
  if (!supportsSvgBackdrop()) return { tone: 'warn', text: '本机内核不支持折射，已退化为普通毛玻璃' }
  if (perfDegraded.value) return { tone: 'warn', text: '已降级到流畅优先（玻璃顶成实底）' }
  return { tone: 'idle', text: '当前档位用普通毛玻璃 · 切到「超高」即开折射' }
})

/** 底部栏的三项（与应用里的 Dock 同名同图标，方便对照观感） */
const TABS = [
  { id: 'home', label: '主页', icon: House },
  { id: 'sports', label: '运动', icon: Dumbbell },
  { id: 'me', label: '我', icon: User },
]
const active = ref('sports')

/** 参数调节面板（液态玻璃管线上的 11 个数字）：入口在标本台正下方 */
const tunerOpen = ref(false)

/** 仅图标按钮的边长（与应用里主按钮的 54 一致），正圆取半高 */
const ICON_BTN = 54
const DOCK_BTN = 58
</script>

<template>
  <div class="page">
    <PageHeader title="画质预览" back />

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
        <div class="parts">
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

        <!-- ③ 组件装配：底部栏（左圆钮 + 中药丸 + 右圆钮）—— 三块玻璃**并列留缝**，
              不互相叠压：各自都带受光边，一叠就会在缝上出现一道月牙形的硬边（像画错了）。
              这一行**不另画一遍**：结构与前景类（.dock-block / .dock-tab / .dock-slot）
              与真实 Dock 共用 base.css 里的那一份，材质也走同一份令牌（不套暗场那套，
              否则标本会比真实 Dock 暗一档）—— 所见即应用里的那一块 -->
        <div class="dockrow">
          <GlassSurface class="dock-block" :width="DOCK_BTN" :height="DOCK_BTN" border-radius="50%" fill="var(--glass-fill)">
            <button type="button" class="dock-slot" aria-label="课表（自定义落点示例）">
              <CalendarDays :size="21" />
              <span>课表</span>
            </button>
          </GlassSurface>

          <GlassSurface class="dock-block pill" :height="DOCK_BTN" border-radius="var(--radius-full)" fill="var(--glass-fill)">
            <button
              v-for="t in TABS"
              :key="t.id"
              type="button"
              class="dock-tab"
              :class="{ active: active === t.id }"
              :aria-pressed="active === t.id"
              @click="active = t.id"
            >
              <component :is="t.icon" :size="22" :stroke-width="active === t.id ? 2.4 : 1.9" />
              <span>{{ t.label }}</span>
            </button>
          </GlassSurface>

          <GlassSurface class="dock-block" :width="DOCK_BTN" :height="DOCK_BTN" border-radius="50%" fill="var(--glass-fill)">
            <button type="button" class="dock-slot" aria-label="AI">
              <Sparkles :size="21" />
              <span>AI</span>
            </button>
          </GlassSurface>
        </div>
      </div>
    </section>

    <!-- 参数调节入口：紧贴标本台 —— 调的就是刚才看到的那几块玻璃。
         面板里改动即时生效（改的是全局那份可调参数），台上三件跟着一起变 -->
    <button type="button" class="tuner" @click="tunerOpen = true">
      <SlidersHorizontal :size="18" />
      <span class="tuner-txt">
        <b>液态玻璃参数调节</b>
        <small class="t-3">折射位移 · 边缘厚度 · 底色浓度…共 11 项，拖动即时生效</small>
      </span>
      <ChevronRight :size="18" class="chev" />
    </button>

    <section class="card">
      <h2 class="ctitle">档位</h2>

      <SegmentedControl v-model="mode" class="perfseg" :options="PERF_OPTIONS" />

      <p class="spec t-3">
        台上三件的尺寸：正圆按钮 54 × 54 · 胶囊按钮 156 × 54 · 底栏高 58（与主按钮同高）
      </p>

      <ul class="modes">
        <li v-for="m in PERF_MODES" :key="m.value" :class="{ on: m.value === perfMode }">
          <b>{{ m.label }}</b>
          <span class="t-3">{{ m.hint }}</span>
        </li>
      </ul>

      <p class="pnote t-3">
        壁纸可以横向拖：玻璃折射的是它背后的东西，拖起来才看得见边缘那道色散。
        内核不支持 <code>backdrop-filter: url()</code>（Safari / Firefox）时自动退化成普通毛玻璃，
        不会留下空白。
      </p>
      <p class="pnote t-3">
        「超高」是手动钉死的档：选了就一直开折射，不参与掉帧自动判定（与「高画质」同理）。
        手机上若觉得发烫或掉帧，切回「自动」即可。
      </p>
    </section>

    <!-- 参数调节面板：自带暗场预览，改的就是全局那份可调参数（system/glassParams） -->
    <GlassTunerSheet :open="tunerOpen" @close="tunerOpen = false" />
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

/* 台内换一套玻璃材质（**调用处的材质上下文**，组件自己的令牌默认值不动）：
   暗底上的玻璃按应用在暗场的做法压暗（HUD 芯片材质），受光边换中性白 ——
   前景因此永远是浅色（--hero-text*），与当前主题无关。
   **只加在「基本件」这一行上**（读数胶囊直接用 --hero-chip-*，不走玻璃令牌）：
   底下的底栏标本要与真实 Dock 一模一样，套上这套暗场令牌就比真实 Dock 暗一档 ——
   它走应用自己的 --glass-* 与前景令牌（见 base.css 的 .dock-* 一份定义）。 */
.parts {
  --glass-fill: var(--hero-chip-bg);
  --glass-rim-hi: var(--hero-chip-line);
  --glass-rim-lo: var(--hero-chip-line);
  --glass-sheen: color-mix(in srgb, var(--hero-text) 8%, transparent);
  --glass-tab-hi: color-mix(in srgb, var(--hero-text) 16%, transparent);
}

/* 弱档：玻璃顶成实底、受光亮斑归零（与 base.css 同一套退化语义，实底取暗场底色） */
html[data-perf='low'] .parts {
  --glass-fill: var(--hero-bg);
  --glass-rim-hi: var(--hero-chip-line);
  --glass-rim-lo: var(--hero-chip-line);
  --glass-sheen: transparent;
  --glass-tab-hi: transparent;
}

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

.spec {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.6;
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
  width: 62px;
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
</style>
