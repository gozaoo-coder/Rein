<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, RefreshCw, Sparkles, ToggleLeft } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { toggleablePlugins } from '@/plugins'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useUpdateStore } from '@/stores/update'
import { MOTION_LEVELS, motionEffective, motionLevel, setMotionLevel, type MotionLevel } from '@/system/motion'
import { PERF_MODES, liquidGlass, perfMode, setPerfMode, type PerfMode } from '@/system/perf'

/**
 * 设置（二级内容页）：从「我」页的设置抽屉升级而来——抽屉放不下第二个分组，
 * 也承载不了「打开或关闭功能」这种需要逐项说明的开关页，因此改成独立页面。
 */
const router = useRouter()
const pomo = usePomodoroStore()
const update = useUpdateStore()

/** 功能行副标：列出可开关模块，一眼看到有哪些功能可关 */
const featureNames = computed(() => toggleablePlugins().map((p) => p.name).join(' · '))

/** 副标：把「有没有新版本」直接写在行里，不必进页面才知道 */
const updateHint = computed(() => {
  if (update.hasUpdate) return `发现新版本 v${update.check?.latestVersion}`
  if (update.check) return `已是最新 v${update.currentVersion}`
  return `当前 v${update.currentVersion || '—'}`
})

/** 性能档位：四个固定档（low / high / ultra / extreme）都是手动钉死（判定逻辑见 system/perf） */
const PERF_OPTIONS = PERF_MODES.map(({ value, label }) => ({ value, label }))

const perfChoice = computed({
  get: () => perfMode.value as string,
  set: (v: string) => {
    if (PERF_MODES.some((m) => m.value === v)) setPerfMode(v as PerfMode)
  },
})

/** 副标要说清当下生效的是哪一档：不支持折射时如实说明，别让人对着退化结果猜 */
const perfHint = computed(() => {
  if (perfMode.value === 'low') return '始终流畅'
  if (perfMode.value === 'extreme') {
    return liquidGlass.value ? '极致 · 完整折射 + 全局玻璃' : '极致 · 已铺全局玻璃（本机不支持折射）'
  }
  if (perfMode.value === 'ultra') {
    return liquidGlass.value ? '超高 · 折射已开（塌缩管线）' : '超高（本机不支持折射）'
  }
  return '始终高画质'
})

/** 动效档位：关闭 / 默认 / 丰富（三档在分段控件里放得下完整名字，不必再给 short） */
const MOTION_OPTIONS = MOTION_LEVELS.map(({ value, label }) => ({ value, label }))

const motionChoice = computed({
  get: () => motionLevel.value as string,
  set: (v: string) => {
    if (MOTION_LEVELS.some((m) => m.value === v)) setMotionLevel(v as MotionLevel)
  },
})

/** 副标要报**实际生效**的那一档：被系统减弱动效、或被掉帧压回默认时，
 *  用户选的那一档并没有生效 —— 与 perfHint 同一条原则（如实说，别让人对着假象猜） */
const motionHint = computed(() => {
  if (motionLevel.value === 'off') return '不做补间'
  if (motionEffective.value !== motionLevel.value) {
    return motionEffective.value === 'off' ? '系统已要求减弱动效' : '已随掉帧退回默认'
  }
  return `当前${MOTION_LEVELS.find((m) => m.value === motionLevel.value)?.label ?? ''}`
})

onMounted(() => {
  // 只在本地读一次快照，不触发联网：设置页不该因为网络慢而卡
  if (!update.snapshot) void update.load()
})
</script>

<template>
  <div class="page">
    <PageHeader title="设置" back />

    <!-- 功能：插件开关入口 -->
    <section class="card">
      <h2 class="gtitle">功能</h2>
      <button class="frow row" @click="router.push({ name: 'settings-features' })">
        <i class="fic" style="background: var(--accent-soft); color: var(--accent)">
          <ToggleLeft :size="18" />
        </i>
        <span class="col ftxt">
          <b>打开或关闭功能</b>
          <em class="t-3">{{ featureNames }}</em>
        </span>
        <ChevronRight :size="16" class="t-3" />
      </button>
    </section>

    <!-- 番茄钟：完整配置（「我」页只保留格内快捷调整） -->
    <section class="card">
      <header class="row between ghead">
        <h2 class="gtitle">番茄钟</h2>
        <span class="num t-3">今日专注 {{ pomo.todayFocusMin }} 分钟</span>
      </header>
      <div class="rows">
        <NumberStepper v-model="pomo.settings.focusMin" label="专注时长" unit="分钟" :step="5" :min="5" :max="120" />
        <NumberStepper v-model="pomo.settings.breakMin" label="短休息" unit="分钟" :step="1" :min="1" :max="30" />
        <NumberStepper v-model="pomo.settings.longBreakMin" label="长休息" unit="分钟" :step="5" :min="5" :max="60" />
        <NumberStepper v-model="pomo.settings.roundsBeforeLongBreak" label="长休间隔" unit="轮" :step="1" :min="2" :max="8" />
      </div>
    </section>

    <!-- 性能：画面档位（掉帧判定与降级落地见 system/perf） -->
    <section class="card">
      <header class="row between ghead">
        <h2 class="gtitle">性能</h2>
        <span class="t-3">{{ perfHint }}</span>
      </header>
      <SegmentedControl v-model="perfChoice" class="perfseg" :options="PERF_OPTIONS" />
      <p class="pnote t-3">
        四档都是手动钉死的固定档，不会在后台自己切。低端机选「流畅」：玻璃顶成实底、
        关掉模糊与循环动画；「高画质」是四层毛玻璃的基线；「超高」在其上再开液态玻璃，
        折射走塌缩管线（全程序只有这一条链，10 个原语降到 3 个）；「极致」与超高的折射
        管线完全相同，差别只在材质 —— 光学层更深一档，并把玻璃材质铺到卡片、抽屉、
        菜单、操作面板与快捷磁贴，材质分层对齐苹果的 Liquid Glass 规范。
      </p>

      <button class="frow row" @click="router.push({ name: 'settings-perf' })">
        <i class="fic" style="background: var(--accent-soft); color: var(--accent)">
          <Sparkles :size="18" />
        </i>
        <span class="col ftxt">
          <b>液态玻璃预览</b>
          <em class="t-3">看这一档的按钮与底部栏长什么样，也可就地切档</em>
        </span>
        <ChevronRight :size="16" class="t-3" />
      </button>
    </section>

    <!-- 动效：与画质档位正交的另一档（判定与落地见 system/motion） -->
    <section class="card">
      <header class="row between ghead">
        <h2 class="gtitle">动效</h2>
        <span class="t-3">{{ motionHint }}</span>
      </header>
      <SegmentedControl v-model="motionChoice" class="perfseg" :options="MOTION_OPTIONS" />
      <p class="pnote t-3">
        「默认」就是现在这一套，不加任何装饰；「丰富」在它之上再加液态玻璃的动作 ——
        底栏与分段控件的液态融合与形变、跟随按压点的定向光晕、抽屉与菜单的透镜式进出、
        页头随滚动收缩与还原。「关闭」不做任何补间：状态直接切换，循环动画也停住。
      </p>
      <p class="pnote t-3">
        动效与画质互不影响：画质档位管的是「这块玻璃画不画得出来」，这里管的是
        「界面要不要动」。掉帧降级时丰富档会自动退回默认，不会一边掉帧一边加合成。
      </p>
    </section>

    <!-- 多设备同步 -->
    <section class="card">
      <h2 class="gtitle">多设备同步</h2>
      <p class="pnote t-3">
        手机、电脑之间同步记录：同一网段直接连，跨网段先用云服务器换地址打洞直连，
        都走不通才经云服务器中转 —— 三条路上跑的**都是端到端加密**的密文，
        服务器看不到内容，也不存业务数据。
      </p>
      <button class="frow row" @click="router.push({ name: 'settings-sync' })">
        <i class="fic" style="background: var(--accent-soft); color: var(--accent)">
          <RefreshCw :size="18" />
        </i>
        <span class="col ftxt">
          <b>多设备同步</b>
          <em class="t-3">配一台新设备、看上次走的哪条路、处理冲突</em>
        </span>
      </button>
    </section>

    <!-- 关于 -->
    <section class="card">
      <h2 class="gtitle">关于</h2>
      <button class="frow row" @click="router.push({ name: 'settings-update' })">
        <i class="fic" style="background: var(--accent-soft); color: var(--accent)">
          <RefreshCw :size="18" />
        </i>
        <span class="col ftxt">
          <b>软件更新</b>
          <em class="t-3">{{ updateHint }}</em>
        </span>
        <ChevronRight :size="16" class="t-3" />
      </button>
      <p class="about t-3">
        Rein v{{ update.currentVersion || '0.2.1' }} · Tauri + Vue + Rust<br>
        架构与编码规范见 docs/ARCHITECTURE.md 与 docs/STANDARDS.md；<br>
        更新链路（多源 + 验签 + 安装）见 docs/UPDATES.md
      </p>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.gtitle {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.ghead + .rows {
  margin-top: 4px;
}

/* 功能行：图标章 + 标题/说明 + 尖括号（与「我」页的格内行同构） */
.frow {
  width: 100%;
  gap: 11px;
  margin-top: 10px;
  padding: 9px 0;
  text-align: left;
  color: inherit;
}

.fic {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
}

.ftxt {
  flex: 1;
  min-width: 0;
  gap: 1px;
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: 600;
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 设置行组：行间细线，首行不留线 */
.rows {
  display: grid;
  grid-template-columns: 1fr;
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}

.about {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.7;
}

.perfseg {
  margin-top: 10px;
}

/* 性能卡里的功能行排在说明文字之后：补一条细线，免得跟上面那段话黏成一块 */
.pnote + .frow {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--line);
}

.pnote {
  margin-top: 10px;
  font-size: var(--fs-micro);
  line-height: 1.7;
}
</style>
