<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'

import TabBar from '@/components/layout/TabBar.vue'
import CommandPalette from '@/components/layout/CommandPalette.vue'
import DesktopRail from '@/components/layout/DesktopRail.vue'
import DesktopInspector from '@/components/layout/DesktopInspector.vue'
import ActiveWorkoutBar from '@/components/exercise/ActiveWorkoutBar.vue'
import RecordFloatBar from '@/components/record/RecordFloatBar.vue'
import GrabFloatBar from '@/components/campus/GrabFloatBar.vue'
import VoiceSessionView from '@/components/voice/VoiceSessionView.vue'
import VoiceFloatBar from '@/components/voice/VoiceFloatBar.vue'
import SessionOverlay from '@/components/exercise/SessionOverlay.vue'
import UpdatePrompt from '@/components/update/UpdatePrompt.vue'
import ToastHost from '@/components/common/ToastHost.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { campusService } from '@/services/campusService'
import { inspectorOpen, rememberRoute, toggleInspector } from '@/system/deskShell'
import { useFeaturesStore } from '@/stores/features'
import { useUpdateStore } from '@/stores/update'
import { useCourseSelectStore } from '@/stores/courseSelect'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
/** 桌面工作台：视口 ≥ DESKTOP_MIN 时以三窗格壳（导航轨 + 主人区 + 右侧信息栏）替代底部 TabBar */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/**
 * 桌面内容形态，由路由 meta.desk 声明（缺省 'grid'）：
 *   · 'grid' —— 卡片流页面：内容区按 --desk-content 收口，页面根铺两栏栅格，
 *               卡片自然摊开（设置、营养、专注这类「一叠卡」的页面都归这里）；
 *   · 'wide' —— 看板 / 画布 / 长表格 / 对话：内容自己撑满主人区，
 *               由页面决定内部怎么分栏。
 * 放在路由表而不是页面里：这是**壳层**的构图决策，导航轨与信息栏都跟着它变，
 * 页面只负责在给定宽度里把内容排好。 */
const deskWide = computed(() => route.meta.desk === 'wide')

/**
 * 桌面键盘层（只在桌面挂）：⌘K 命令面板、⌘1–4 一级页、⌘I 信息栏。
 *
 * 为什么由壳层统一收：快捷键**不能分布在各页**（同一组合在两个页面里含义不同，
 * 用户就再也不敢按）；而这些都是「壳层的动作」—— 换页、开关窗格、叫出面板。
 * 页面自己的键位仍留在页面里（如 Esc 关抽屉），壳层只认这一组不冲突的。
 *
 * 输入焦点要排除：在输入框 / 文本域 / contenteditable 里按 ⌘1 应该照常输入，
 * 只有 ⌘K 与 ⌘I 这类带修饰键、输入法不会吃掉的组合才允许穿透。
 */
const paletteOpen = ref(false)

const deskKeys: Record<string, string> = {
  '1': 'home',
  '2': 'sports',
  '3': 'ai',
  '4': 'me',
}

function onDeskKey(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  if (mod && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    toggleInspector()
    return
  }
  if (e.key === 'Escape' && paletteOpen.value) {
    e.preventDefault()
    paletteOpen.value = false
    return
  }
  if (!mod || e.altKey) return
  const target = e.target as HTMLElement | null
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
  if (typing) return
  const name = deskKeys[e.key]
  if (name) {
    e.preventDefault()
    void router.push({ name })
  }
}

/** 最近访问：命令面板的「最近」组靠它。名字而已，不存数据。 */
watch(
  () => route.name,
  (n) => {
    if (isDesktop.value && typeof n === 'string') rememberRoute(n)
  },
)

/** 全屏形态：fullscreen 路由（跑步）或训练课沉浸层打开——隐藏壳导航与悬浮条 */
const shellVisible = computed(() => route.meta.fullscreen !== true)

/* ---------------- 参数错误 → 立刻交给 AI 补救 ----------------
 *
 * 教务说「参数错误」就是**这条请求的写法不对**：重试一万次也是同一个结果，
 * 而且每次都在用错的参数骚扰教务。引擎那边会停下来把任务标成 `needs_ai`
 * （见 grab.rs 的 `absorb_error`），这里负责**立刻把现场递给 AI**：
 * 用户要的是「放着不管它也有人在救」，而不是「先弹个提示等我来点」。
 *
 * 放在 App 层而不是抢课页里：用户可能已经翻去别的页面了，救援不该挑页面。
 * 每条任务只自动递一次（AI 那边可能有来回，不能反复把人拽走），之后
 * 面板上仍有「交给 AI 排查」的手动入口。
 *
 * **整个 watcher 受抢课开关管**：模块关着的时候任务根本不会推进，
 * 更不该把用户拽去 AI 页。
 *
 * 救援模块**按需 import**：`utils/campusAi` 认识 `stores/ai`，而 `stores/ai` 拖进来的是
 * 整个 AI 工具栈（工具注册表 + 全部工具域，约 200 KB）。App 是每个路由的父级，
 * 这里静态 import 一句就等于把 AI 栈钉进启动主包 —— 与文档「AI 层不静态进主包」相悖。
 * 这条分支只在教务真的拒了请求时才走到，按需加载不亏任何一次首屏。
 */
const courseSelect = useCourseSelectStore()
const features = useFeaturesStore()
/** 抢课模块是否开着（课表的子模块，默认关闭） */
const grabOn = computed(() => features.isEnabled('campus-grab'))
const toast = useToast()
const aiHandedOff = new Set<number>()
watch(
  () => courseSelect.grabTasks.map((t) => `${t.id}:${t.status}`).join(','),
  () => {
    if (!grabOn.value) return
    const bad = courseSelect.rejectedTasks.filter((t) => !aiHandedOff.has(t.id))
    if (!bad.length) return
    for (const t of bad) aiHandedOff.add(t.id)
    const first = bad[0]!
    // 现场先快照，再异步加载救援模块（理由见下方 import 注释）
    const scene = courseSelect.grab
    void import('@/utils/campusAi').then(({ askAiForGrabRescue }) => askAiForGrabRescue(scene))
    toast.toast(
      `教务拒绝了抢课请求（参数错误）：「${first.courseName ?? first.lessonName ?? '这门课'}」已交给 AI 排查`,
    )
  },
)

/**
 * 把抢课开关同步给 Rust 引擎。三个时机都要做，缺一个就会出现
 * 「界面关了、引擎还在跑」这种最糟的不一致：
 * 1. 启动时（引擎自己也会从 `app_meta` 读，这里是双保险 + 覆盖热重载）；
 * 2. 开关被拨动时（含在设置页里拨）；
 * 3. 父模块「课表」被关掉时 —— 子模块随之失效，引擎也必须停。
 */
watch(
  grabOn,
  (on) => {
    void campusService.grabSetEnabled(on).catch(() => {
      /* 引擎开关同步失败不该弹错：下次拨动或重启会再同步一次 */
    })
  },
  { immediate: true },
)

/**
 * 启动静默检查更新：只在「开关开着 + 距上次检查超过间隔」时真的联网，
 * 有新版本就弹一张明确的更新卡片（立即更新 / 稍后 / 跳过此版本）。
 * 刻意不阻塞任何首屏渲染：慢网络下最坏的结果只是卡片晚几秒出现。
 */
const updatePrompt = ref(false)

/* 键盘层随桌面壳一起挂/卸：窄屏没有导航轨与信息栏，⌘1–4 / ⌘I 在那里没有意义，
   而 ⌘K 面板本身也不渲染 —— 监听器跟着 isDesktop 走，两种形态各自只有一份真相。 */
watch(
  isDesktop,
  (on) => {
    if (on) window.addEventListener('keydown', onDeskKey)
    else window.removeEventListener('keydown', onDeskKey)
    /* 壳层形态写到 <html> 上：**teleport 到 body 的元素（悬浮钮 / 悬浮条 / 提示条）
       不在 .desk-main 里**，它们既用不了 .desk-main 那条祖先规则，也读不到
       「现在是不是桌面」。写一个属性出去，这些游离子孙就能各自适配 —
       与 data-perf / data-motion / data-immersive 同一条做法。 */
    document.documentElement.dataset.shell = on ? 'desk' : 'mobile'
  },
  { immediate: true },
)

/* 信息栏的开合也写到 <html>：理由同上 —— 靠右缘定位的游离子孙要跟着让位 */
watch(inspectorOpen, (v) => {
  document.documentElement.dataset.inspector = v ? 'on' : 'off'
}, { immediate: true })

onBeforeUnmount(() => window.removeEventListener('keydown', onDeskKey))

onMounted(() => {
  const update = useUpdateStore()
  void (async () => {
    await update.load()
    if (await update.autoCheckIfDue()) updatePrompt.value = true
  })()
})
</script>

<template>
  <!-- 桌面三窗格壳：沉浸页（运动模式）同样隐藏导航轨 -->
  <div v-if="isDesktop" class="desk-frame">
    <DesktopRail
      v-show="shellVisible"
      data-immersive-shell
      :inspector-open="inspectorOpen"
      @toggle-inspector="toggleInspector"
      @open-palette="paletteOpen = true"
    />
    <main class="desk-main" :class="{ wide: deskWide }">
      <!-- 整页包装：平时只是路由出口的壳。页面自己挂了内容层（.page > .rubber-layer）
           时超伸平移落在那一层上（system/rubberScroll 的 layerFor 会下钻找到它）；
           只有没挂内容层的页面才回退到整页平移（那时标题栏会跟着动）。 -->
      <div data-rubber-shell>
        <RouterView v-slot="{ Component }">
          <Transition name="page">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </div>
    </main>
    <!-- 第三窗格 · 路由上下文信息栏：全页面常驻（沉浸页除外、可 ⌘I 收起），
         保证桌面构图平衡；窄桌面下用户也可以把它让给主内容 -->
    <DesktopInspector v-show="shellVisible && inspectorOpen" data-immersive-shell />
  </div>

  <!-- 移动端（原结构）：内容居中窄栏 + 底部标签导航 -->
  <div v-else class="app-frame">
    <!-- 整页包装（= 页面级超伸的兜底层）：页面自己挂了内容层时只动内容层，
         标题栏留在层外不动；没挂内容层的旧页面才整页平移 -->
    <div data-rubber-shell>
      <RouterView v-slot="{ Component }">
        <Transition name="page">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </div>
    <TabBar
      v-show="shellVisible"
      data-immersive-shell
    />
  </div>
  <!-- 悬浮运动条：收起完成后才恢复，自身按停靠方向渐入 -->
  <ActiveWorkoutBar />
  <!-- 录音悬浮条：录音进行中常驻（可拖拽停靠，轻点进录音页） -->
  <RecordFloatBar v-show="shellVisible" data-immersive-shell />
  <!-- 语音转写悬浮条：语音会话收起后台转写继续（与录音浮条同套停靠、独立 key） -->
  <VoiceFloatBar v-show="shellVisible" data-immersive-shell />
  <!-- 抢课监视器：后台引擎有活儿时顶部落一条，点进选课页（顶部定位，不与底部三条浮条抢位）。
       受模块开关管：关掉抢课（默认关）就不该有任何常驻 UI。 -->
  <GrabFloatBar v-if="grabOn" v-show="shellVisible" data-immersive-shell />
  <!-- 语音会话视图：单例 runtime 驱动，任何入口可唤起（voiceRuntime.openView） -->
  <VoiceSessionView />
  <!-- 训练课沉浸层：常驻挂载不走路由（system/sessionImmersive 驱动显隐与形变） -->
  <SessionOverlay />
  <!-- 命令面板（⌘K）：桌面专属 —— 它是键盘入口，触屏上没有对应手势 -->
  <CommandPalette v-if="isDesktop" :open="paletteOpen" @close="paletteOpen = false" />
  <!-- 启动检查到新版本时的更新卡片（立即更新 / 稍后 / 跳过此版本） -->
  <UpdatePrompt :open="updatePrompt" @close="updatePrompt = false" />
  <ToastHost />
</template>

<style scoped>
.app-frame {
  position: relative;
  max-width: var(--frame-max);
  min-height: 100dvh;
  margin: 0 auto;
  /* 避开手机状态栏/刘海；环境光是这一栏自己的 ::before 固定层（base.css「环境光」段），
     内容从它上面滚过去 —— 它不铺到窗口两侧去 */
  padding-top: var(--safe-top);
}

/* 桌面壳：导航轨 + 主人区 */
.desk-frame {
  display: flex;
  height: 100dvh;
  overflow: hidden;
}

.desk-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  /* 桌面下的横向留白与页头遮罩宽度：页面里那句 var(--page-pad-x) 会自己跟上，
     所以各页不必为桌面再写一遍 padding。 */
  --page-pad-x: var(--desk-gutter);
  --ph-bleed: var(--desk-gutter);
}

/* ---------- 桌面内容画布 · 卡片流（meta.desk = 'grid'，缺省） ----------
   移动端那套「一列窄栏居中」在桌面上会留下两侧各 300px 的空白，读起来像没做完。
   这里把页面根直接铺成两栏栅格：**通栏是缺省、卡片是半栏**——
   因为页面里除卡片之外的东西（页头、看板、通栏列表、提示条）本来就该占满一行，
   而 .card 正是「可以并排的一块」，这样一个规则就让二十来个卡片页在桌面上自动成形，
   不需要每页各写一遍媒体查询。只有真正需要另一种构图的页面才去加 d-full / d-split。 */
.desk-main:not(.wide) :deep(.page) {
  max-width: var(--desk-content);
  margin: 0 auto;
  padding-top: 26px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--desk-gap);
  /* stretch：同行两卡高度对齐（矮卡填满格子），灰底画布不再从卡下漏出；
     align-content: start：内容不满一屏时多余高度留在底部，而不是被分到行间
     （不然短页面会在标题和第一张卡之间凭空多出一条大空档）。 */
  align-items: stretch;
  align-content: start;
}

/* 子项怎么摆**不在这里定**：整行 / 半栏的缺省与 d-* 工具的优先级必须在同一份
   样式表里排序才说得清（见 base.css「桌面工作台 · 栅格」）——分成两个文件写，
   工具类的特指度就会被这里的 :deep 组合压掉，页面作者加了 class 却不生效。
   这里只负责 .page 这个盒子本身。 */

/* ---------- 桌面内容画布 · 宽形态（meta.desk = 'wide'） ----------
   宽形态**不写任何 .page 规则**：上面那条栅格只在 :not(.wide) 时命中，
   所以标了 wide 的页面拿到的就是自己原来的盒模型（AI 页的整帧 flex、待办页的
   一天画布都靠这个），桌面改动完全落在页面自己的 scoped 样式里。
   这样壳层与页面之间只有一条契约：「wide = 主人区整宽，构图你自己负责」，
   不会出现壳层用 max-width 压住页面自己那条 max-width 的级联扯皮。 */

/* 主人区里的页面画布按 --desk-wide 收口（宽形态页面的通行做法） */
.desk-main.wide :deep(.page) {
  margin-inline: auto;
}

/* 页面切换：新页淡入衔接，旧页同步让位——不做 out-in 空屏，也不做旧页淡出 */
.page-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.page-enter-from {
  opacity: 0;
}

/* 离场瞬时移除：淡出会与入场抢同一段视觉，读起来像两次变化 */
.page-leave-active {
  transition: none;
}
</style>
