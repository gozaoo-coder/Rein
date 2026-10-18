<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, HeartPulse, RefreshCw, Sparkles, ToggleLeft, Trash2 } from 'lucide-vue-next'

import DataClearSheet from '@/components/settings/DataClearSheet.vue'
import ExternalAccessSection from '@/components/settings/ExternalAccessSection.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { toggleablePlugins } from '@/plugins'
import { useFeaturesStore } from '@/stores/features'
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
const features = useFeaturesStore()

/** 番茄钟配置属于「专注」模块、多设备同步属于「同步」模块：模块关掉时整卡收起
 *  （配置项是那个模块的旋钮，模块不在就没有可调的对象 —— 半边留着就是「半关」） */
const focusOn = computed(() => features.isEnabled('focus'))
const syncOn = computed(() => features.isEnabled('sync'))

/** 番茄钟时长档位快捷预设：与手调步进器并存（档位给快捷、步进给精确） */
const FOCUS_PRESETS = [
  { min: 25, label: '利落 25' },
  { min: 45, label: '沉浸 45' },
  { min: 90, label: '深流 90' },
]

/** 清除软件数据抽屉（四档深度 + 两段确认，见 DataClearSheet） */
const clearOpen = ref(false)

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
    return liquidGlass.value ? '极致 · 折射 + 全局玻璃' : '极致 · 已铺全局玻璃（本机不支持折射）'
  }
  if (perfMode.value === 'ultra') {
    return liquidGlass.value ? '超高 · 折射已开（塌缩管线）' : '超高 · 已铺全局玻璃（本机不支持折射）'
  }
  return '高画质 · 全局玻璃（无折射）'
})

/** 动效档位：关闭 / 默认 / 丰富（三档在分段控件里放得下完整名字，不必再给 short） */
const MOTION_OPTIONS = MOTION_LEVELS.map(({ value, label }) => ({ value, label }))

const motionChoice = computed({
  get: () => motionLevel.value as string,
  set: (v: string) => {
    if (MOTION_LEVELS.some((m) => m.value === v)) setMotionLevel(v as MotionLevel)
  },
})

/** 副标要报**实际生效**的那一档：被系统减弱动效、或被画质档位压回默认时，
 *  用户选的那一档并没有生效 —— 与 perfHint 同一条原则（如实说，别让人对着假象猜） */
const motionHint = computed(() => {
  if (motionLevel.value === 'off') return '不做补间'
  if (motionEffective.value !== motionLevel.value) {
    return motionEffective.value === 'off' ? '系统已要求减弱动效' : '画质选「流畅」时退回默认'
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
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 功能：插件开关入口 -->
    <section class="card d-full">
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

    <!-- 番茄钟：完整配置（专注 / 短休 / 长休 / 轮数都在这一处调）。属「专注」模块 -->
    <section v-if="focusOn" class="card">
      <header class="row between ghead">
        <h2 class="gtitle">番茄钟</h2>
        <span class="num gstate t-3">今日专注 {{ pomo.todayFocusMin }} 分钟</span>
      </header>
      <div class="card sub rows">
        <!-- 时长档位：三枚快捷预设写进 focusMin；下面的步进器仍可精确手调，两者不冲突 -->
        <div class="preset-row">
          <span class="slabel">时长档位</span>
          <div class="row prow">
            <PillChip
              v-for="p in FOCUS_PRESETS"
              :key="p.min"
              as="button"
              size="sm"
              :tone="pomo.settings.focusMin === p.min ? 'action' : 'muted'"
              :aria-label="`设置专注时长 ${p.min} 分钟`"
              @click="pomo.settings.focusMin = p.min"
            >
              {{ p.label }}
            </PillChip>
          </div>
        </div>
        <NumberStepper v-model="pomo.settings.focusMin" label="专注时长" unit="分钟" :step="5" :min="5" :max="120" />
        <NumberStepper v-model="pomo.settings.breakMin" label="短休息" unit="分钟" :step="1" :min="1" :max="30" />
        <NumberStepper v-model="pomo.settings.longBreakMin" label="长休息" unit="分钟" :step="5" :min="5" :max="60" />
        <NumberStepper v-model="pomo.settings.roundsBeforeLongBreak" label="长休间隔" unit="轮" :step="1" :min="2" :max="8" />
        <div class="row between srow">
          <span class="slabel">结束提示音</span>
          <ToggleSwitch v-model="pomo.settings.chime" label="结束提示音" />
        </div>
      </div>
    </section>

    <!-- 性能：画面档位（掉帧判定与降级落地见 system/perf） -->
    <section class="card">
      <header class="row ghead">
        <h2 class="gtitle">性能</h2>
        <span class="gstate t-2">{{ perfHint }}</span>
        <span class="hint-slot">
          <InfoHint title="画质档位说明">
            <p>「流畅」把玻璃顶成实底，关掉模糊与循环动画，最省电；「默认」「超高」「极致」逐档更透，也更吃性能。</p>
            <p>四档都是手动档，切换后立即生效，不会在后台自己切，也不会自己升降。</p>
          </InfoHint>
        </span>
      </header>
      <SegmentedControl v-model="perfChoice" class="perfseg" :options="PERF_OPTIONS" />
      <p class="pnote t-2">四档都是手动档，不会自己切；卡顿就手动切到「流畅」。</p>

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
      <header class="row ghead">
        <h2 class="gtitle">动效</h2>
        <span class="gstate t-2">{{ motionHint }}</span>
        <span class="hint-slot">
          <InfoHint title="动效档位说明">
            <p>「默认」就是现在这一套，不加装饰；「丰富」多加液态动作；「关闭」不做补间，状态直接切换。</p>
            <p>画质档位管「玻璃画不画得出来」，这里管「界面动不动」——两件事互不影响。</p>
            <p>画质选「流畅」时，「丰富」会退回「默认」；系统要求减弱动效时，全部档位都按「关闭」执行。</p>
          </InfoHint>
        </span>
      </header>
      <SegmentedControl v-model="motionChoice" class="perfseg" :options="MOTION_OPTIONS" />
    </section>

    <!-- 多设备同步。属「同步」模块（模块关掉时整卡收起，直链也被守卫拦回主页） -->
    <section v-if="syncOn" class="card">
      <header class="row ghead">
        <h2 class="gtitle">多设备同步</h2>
        <span class="hint-slot">
          <InfoHint title="同步怎么连">
            <p>同一网段直接连；跨网段先用云服务器换地址打洞直连；都走不通才经云服务器中转。</p>
            <p>三条路上跑的都是端到端加密的密文，服务器看不到内容，也不存业务数据。</p>
          </InfoHint>
        </span>
      </header>
      <p class="pnote t-2">设备之间端到端加密同步，服务器不存内容。</p>
      <button class="frow row" @click="router.push({ name: 'settings-sync' })">
        <i class="fic" style="background: var(--accent-soft); color: var(--accent)">
          <RefreshCw :size="18" />
        </i>
        <span class="col ftxt">
          <em class="t-3">配一台新设备、看上次走的哪条路、处理冲突</em>
        </span>
      </button>
    </section>

    <!-- 外部访问：对外服务网关（开关 / 绑定模式 / 端口 / 已授权程序） -->
    <ExternalAccessSection />

    <!-- 第三方数据管理 -->
    <section class="card">
      <h2 class="gtitle">第三方数据管理</h2>
      <p class="pnote t-3">
        手机上的运动 App（小米运动健康等）把数据写进系统的 Health Connect，
        Rein 从这里读进来，也可以把自己的运动回写出去。
      </p>
      <button class="frow row" @click="router.push({ name: 'settings-health' })">
        <i class="fic" style="background: var(--accent-soft); color: var(--accent)">
          <HeartPulse :size="18" />
        </i>
        <span class="col ftxt">
          <em class="t-3">健康数据授权、同步手环/运动 App 的记录</em>
        </span>
      </button>
    </section>

    <!-- 数据：分层清除（缓存 / AI 会话 / 业务数据 / 恢复出厂），危险区入口用危险色 -->
    <section class="card">
      <h2 class="gtitle">数据</h2>
      <button class="frow row" data-testid="settings-data-clear" @click="clearOpen = true">
        <i class="fic" style="background: var(--danger-soft); color: var(--danger)">
          <Trash2 :size="18" />
        </i>
        <span class="col ftxt">
          <b>清除软件数据</b>
          <em class="t-3">四档由浅到深，清除前先列出清单再确认</em>
        </span>
        <ChevronRight :size="16" class="t-3" />
      </button>
    </section>

    <!-- 关于 -->
    <section class="card d-full">
      <header class="row ghead">
        <h2 class="gtitle">关于</h2>
        <span class="hint-slot">
          <InfoHint title="关于 Rein">
            <p>Rein 基于 Tauri + Vue + Rust 构建。</p>
            <p>架构与编码规范见 docs/ARCHITECTURE.md 与 docs/STANDARDS.md；更新链路（多源 + 验签 + 安装）见 docs/UPDATES.md。</p>
          </InfoHint>
        </span>
      </header>
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
    </section>
    </div>

    <!-- 清除软件数据：选档 → 真实统计清单 → 长按确认（两段确认都在抽屉里完成） -->
    <DataClearSheet :open="clearOpen" @close="clearOpen = false" />
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

/* 卡头行：标题 + 状态副标 + 右侧帮助入口 */
.ghead {
  gap: 8px;
}

/* 卡头状态副标：原先只给颜色不给字号，继承了 body 的 17px，比 13px 的卡头标题还大；
   此刻生效的是哪一档是必读信息，走 --text-2，补充性事实（如今日专注）才压 t-3 */
.gstate {
  font-size: var(--fs-caption);
}

/* 标题行右侧的帮助入口：InfoHint 是多根组件，类要落在包裹元素上 */
.hint-slot {
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

/* 番茄钟卡内行组与卡头之间恒为 4px（.rows 成了 .card.sub，原来的 .ghead + .rows 4px 保留） */
.ghead + .card.sub {
  margin-top: 4px;
}

/* 番茄钟「时长档位」预设行：标签在上、胶囊在下（窄宽下胶囊可换行，不挤成一排） */
.preset-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prow {
  gap: 6px;
  flex-wrap: wrap;
}

/* 与 NumberStepper 的 .label 同档（--fs-subhead / 500），行组里两种标签才并排一致 */
.slabel {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

/* 「结束提示音」开关行：与步进器行同一垂直节奏（.rows > * + * 已给行间细线） */
.srow {
  padding: 7px 0;
}

/* 桌面（有悬停）：预设胶囊给悬停反馈（按压由全局 button:active 承担） */
@media (hover: hover) {
  .prow .chip:hover {
    background: var(--surface-3);
  }
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

/* 设置行组：整组垫在 .card.sub 那口浅井上（底 / 圆角 / 内距 / 无影都在 base.css 里），
   这里只留「行间细线，首行不留线」这一条分组自己的规则 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
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

/* 说明段（.pnote）解释的是「这档是干什么的、会怎样」，属于要读的正文，不吃 11px */
.pnote {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.7;
}
</style>
