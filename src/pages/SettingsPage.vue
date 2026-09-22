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
import { PERF_MODES, liquidGlass, perfDegraded, perfMode, setPerfMode, type PerfMode } from '@/system/perf'

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

/** 性能档位：auto 按掉帧判定自动切换，high / ultra / low 手动钉死（判定逻辑见 system/perf） */
const PERF_OPTIONS = PERF_MODES.map(({ value, label }) => ({ value, label }))

const perfChoice = computed({
  get: () => perfMode.value as string,
  set: (v: string) => {
    if (PERF_MODES.some((m) => m.value === v)) setPerfMode(v as PerfMode)
  },
})

/** 副标要说清当下生效的是哪一档——自动降级和用户自己选的「流畅优先」不是一回事 */
const perfHint = computed(() => {
  if (perfMode.value === 'low') return '始终流畅优先'
  if (perfMode.value === 'ultra') return liquidGlass.value ? '超高 · 液态玻璃已开' : '超高（本机不支持折射）'
  if (perfMode.value === 'high') return '始终高画质'
  return perfDegraded.value ? '已自动降级' : '当前高画质'
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
        连续掉帧时自动降级：页头的渐进模糊换成底色遮罩，并关掉毛玻璃与循环动画。
        低端机可手动固定「流畅优先」，画面更好的机器可固定「高画质」省去判定；
        「超高」在高画质之上再开液态玻璃（折射表面），是本机最耗性能的一档。
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
