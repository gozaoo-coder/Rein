<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Expand } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import GlassFilter from '@/components/common/GlassFilter.vue'
import { workoutRuntime } from '@/system/workoutRuntime'
import { immersiveClosing, immersiveOpen, immersiveReturning, openImmersive, setImmersiveOriginProvider } from '@/system/sessionImmersive'
import { liquidGlass } from '@/system/perf'
import { useDragDock } from '@/composables/useDragDock'
import { useToast } from '@/composables/useToast'

/**
 * 悬浮运动条：导航栏上方常驻的「当前运动」视图（App.vue 挂载，
 * 沉浸形态下隐藏：fullscreen 路由（跑步）或训练课沉浸层打开；
 * 收起动画期间提前回归与形变块接续）。
 * 数据与动作全部来自运动系统运行时（system/workoutRuntime）：
 * 跑步 = 配速 · 里程 · 暂停（必须暂停再结束）；课程 = 动作名 ·
 * 当前组数 · 完成本组。原有各页「检测到未完成的训练」恢复提示
 * 由本条接管——运行时启动即恢复会话，无运动时整条不显示。
 *
 * 可拖拽停靠（useDragDock）：整条可拖，松手按速度方向吸附到
 * 顶 / 底（全宽条）或左右边缘（64px 方块泊车态，轻点展开回条）。
 * 结构三层各司其职：root 只管 fixed 定位与 z 序、pos 只被弹簧写
 * transform、body 承载视觉与两层内容交叉淡变。停靠在 bottom 时
 * 通过 --wbar-reserve 给页面内容追加底部空间（tokens.css 的
 * --page-pad-bottom 计入），页面已滚到底则自动跟随滚到新位置，
 * 让被本条盖住的末尾内容滑出来。
 */
const rt = workoutRuntime
const router = useRouter()
const { toast } = useToast()

const view = rt.view
const endOpen = ref(false)
const rootEl = ref<HTMLElement | null>(null)

/* ---------- 拖拽停靠 ---------- */
const posEl = ref<HTMLElement | null>(null)
const { slot, form, pressing, dragging, onPointerDown, expandFromBlob } = useDragDock(posEl)

/* ---------- 材质：超高档起换**真折射**（与 Dock / 页头圆钮同一条管线）----------
 * `.glass-surface` 那份是「模糊 + 令牌」的毛玻璃：档位升级只换令牌，超高下它仍然只是
 * 一层糊，拿不到折射。而这一条是**悬浮件**（浮在页面内容之上、底下真的有东西会动），
 * 正是苹果那条「折射给控制层的离散件」的适用对象。
 *
 * 做法与 GlassSurface 的折射分支一致：把元素自己的 `backdrop-filter` 从 blur() 换成
 * `url(#filters)`，底 / 受光边 / 光学层继续由 `.glass-surface` 那套令牌给（同一块材质，
 * 只换"怎么采样背后"这一步）。滤镜定义来自 common/GlassFilter.vue，量尺默认是父元素 ——
 * 也就是本条浮条的 .dock-body 自己，条形态与 64px 方块形态的尺寸变化由它自己重烘贴图。
 *
 * 三条边界：① 只在 liquidGlass（超高 / 极致 + 内核画得出来）时才挂，其余档位走原来的
 * 毛玻璃；② 减弱透明度时由 base.css 的媒体查询带 !important 压掉（内联样式它压不过）；
 * ③ 拖拽的 transform 不碍事 —— 实测 Chromium 下元素自身与祖先的 transform /
 * will-change 都不影响背景采样，只有 opacity<1 的祖先会（进入动画那 400ms 内就是这种
 * 情况：与从前挂 blur 时同一段退化，动画结束即恢复）。 */
const glassFilterId = `glass-filter-${Math.random().toString(36).slice(2, 10)}`
const glassStyle = computed<Record<string, string> | undefined>(() => {
  if (!liquidGlass.value) return undefined
  const filter = `url(#${glassFilterId}) saturate(var(--glass-sat))`
  return { backdropFilter: filter, WebkitBackdropFilter: filter }
})

// 注册形变锚点供给：沉浸层展开快照 / 收起实时量取都从 body 取
// （getter 形式——收起时浮窗已恢复显示且可能刚被重新停靠，须现取现量）。
// 量 body 而非 posEl：border-radius（bar/blob 两态不同）长在 body 上。
// posEl 尚未落位（placeInstant 未写 transform，如开课瞬间浮窗刚随
// view 渲染）时返回 null——量到的 (0,0) 会让形变从屏幕左上角长出。
onMounted(() => {
  setImmersiveOriginProvider(() => {
    const pos = posEl.value
    if (!pos || getComputedStyle(pos).transform === 'none') return null
    return (pos.firstElementChild as HTMLElement | null) ?? pos
  })
})

/* 沉浸收起的显形不在这里播动画：closing 期浮条就保持在原位（被形变壳盖住），
   壳贴落后由 SessionOverlay 的落位溶解露出——浮条自己始终没动过。 */

/** 移动端是文档级滚动；桌面三窗格壳滚在 .desk-main 上 */
function activeScroller(): HTMLElement | null {
  const dm = document.querySelector('.desk-main')
  if (dm instanceof HTMLElement) return dm
  return (document.scrollingElement as HTMLElement | null) ?? null
}

watch([immersiveOpen, immersiveClosing, immersiveReturning], ([open, closing, returning]) => {
  const root = rootEl.value
  document.documentElement.dataset.immersive = returning ? 'returning' : closing ? 'closing' : open ? 'open' : 'ready'
  if (!root) return
  root.classList.toggle('immersive-hidden', open && !closing)
  // closing 期浮条保持**可见**（被不透明的形变壳盖住，仅作收起锚点与落位底）：
  // 形变壳贴到它的 rect 上后由落位溶解露出，不再另播滑入动画。
  root.classList.toggle('immersive-measuring', closing)
}, { immediate: true })

watch(
  [slot, view],
  async ([s, v]) => {
    const rootStyle = document.documentElement.style
    if (!v || s !== 'bottom') {
      rootStyle.removeProperty('--wbar-reserve')
      return
    }
    // 先在旧布局上判断是否已滚到底，再让预留生效——flush:'post' 保证
    // 读到的是切换后形态的真实高度，而 padding 此刻尚未变化
    const sc = activeScroller()
    const atEnd = sc ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : false
    const h = posEl.value?.getBoundingClientRect().height || 58
    rootStyle.setProperty('--wbar-reserve', `${Math.round(h + 14)}px`)
    await nextTick()
    // 已在底部还往下补了空间：跟着滚到底，把被悬浮条盖住的内容露出来
    if (atEnd && sc) sc.scrollTop = sc.scrollHeight
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(() => {
  document.documentElement.style.removeProperty('--wbar-reserve')
})

/* ---------- 原有动作语义不变 ---------- */
const endTitle = computed(() =>
  view.value?.kind === 'run' ? '结束本次跑步？' : '结束本次训练？',
)

const endActions = computed(() =>
  view.value?.kind === 'run'
    ? [
        { label: '结束并保存', value: 'finish' },
        { label: '放弃本次跑步（不保存）', value: 'discard', danger: true },
      ]
    : [
        { label: '结束并保存', value: 'finish' },
        { label: '放弃本次训练（不保存）', value: 'discard', danger: true },
      ],
)

function goImmersive(): void {
  // 训练课：从浮窗当前位置形变展开为沉浸层（不走路由，任意吸附位同理）；
  // 跑步仍是路由沉浸页。锚点走 provider（量 body，圆角正确）
  if (rt.kind.value === 'course') openImmersive()
  else void router.push(rt.immersiveRoute.value)
}

async function onEndPick(value: string): Promise<void> {
  if (value === 'finish') {
    if (rt.kind.value === 'run') {
      // 跑步先冻结进总结页，距离核对 / 补填在沉浸页完成
      rt.enterRunSummary()
      goImmersive()
    } else {
      const r = await rt.finishCourse()
      if (r) toast(`已保存 ${r.done} 组 · 约 ${r.durationMin} 分钟 · ${r.kcal} 大卡`)
    }
  } else if (value === 'discard') {
    const wasRun = rt.kind.value === 'run'
    await rt.discardActive()
    toast(wasRun ? '已放弃本次跑步' : '已放弃本次训练')
  }
}
</script>

<template>
  <section
    v-if="view"
    ref="rootEl"
    class="wdock-root"
    :class="[`dock-${slot}`, { dragging }]"
  >
      <div ref="posEl" class="dock-pos">
        <div
          class="dock-body glass-surface"
          :class="[form === 'blob' ? 'is-blob' : 'is-bar', { pressing, dragging }]"
          :style="glassStyle"
          role="region"
          aria-label="进行中的运动"
          @pointerdown="onPointerDown"
        >
          <!-- 折射滤镜定义（不参与绘制，绝对定位）：只在超高档挂，量尺是这个 .dock-body -->
          <GlassFilter :id="glassFilterId" :enabled="liquidGlass" />

          <!-- 全宽条形态 -->
          <div class="layer layer-bar" :class="{ off: form !== 'bar' }">
            <button class="info row" type="button" @click="goImmersive">
              <span class="dot" :class="{ live: view.running, pause: view.paused, done: view.summary }" />
              <span class="lines col">
                <b class="t">{{ view.title }}</b>
                <span class="s num">{{ view.stat }}</span>
              </span>
            </button>

            <div class="acts row">
              <button
                v-if="view.kind === 'run' && view.running"
                class="abtn main"
                type="button"
                @click="rt.pauseActive()"
              >
                暂停
              </button>
              <button
                v-else-if="view.kind === 'run' && view.paused"
                class="abtn main"
                type="button"
                @click="rt.resumeActive()"
              >
                继续
              </button>
              <button
                v-else-if="view.completeLabel"
                class="abtn main"
                type="button"
                @click="rt.completeCurrentSet()"
              >
                {{ view.completeLabel }}
              </button>
              <button v-if="view.summary" class="abtn main" type="button" @click="goImmersive">
                去保存
              </button>
              <button v-if="view.canEnd" class="abtn end" type="button" @click="endOpen = true">
                结束
              </button>
              <button class="abtn ico" type="button" aria-label="恢复沉浸模式" @click="goImmersive">
                <Expand :size="15" :stroke-width="2.5" />
              </button>
            </div>
          </div>

          <!-- 方块泊车形态：轻点展开回全宽条 -->
          <button
            class="layer layer-blob"
            :class="{ off: form !== 'blob' }"
            type="button"
            aria-label="展开运动控制"
            @click="expandFromBlob"
          >
            <span class="dot" :class="{ live: view.running, pause: view.paused, done: view.summary }" />
            <b class="bt num">{{ view.blob }}</b>
          </button>
        </div>
      </div>

      <!-- 结束（二级确认）：与沉浸页同一条结束语义 -->
      <ActionSheet
        :open="endOpen"
        :title="endTitle"
        :actions="endActions"
        @select="void onEndPick($event)"
        @close="endOpen = false"
      />
  </section>
</template>

<style scoped>
/* root：只管 fixed 定位与 z 序（零尺寸、不接事件），位移全在 .dock-pos */
.wdock-root {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 59; /* 页面内容之上、TabBar(60) 之下 */
  pointer-events: none;
}

.wdock-root.dragging {
  z-index: 70; /* 拖拽 / 飞行中盖过 TabBar，落位即回 */
}

.dock-pos {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}

/* body：共享视觉外壳；条形态尺寸由内层内容撑开，方块形态定死 64。
   材质（玻璃底 / 受光边 / 内顶高光 / blur / 投影 / 退化）走全局 .glass-surface ——
   与底部 Dock 同一份定义，悬浮的这一族看起来才是同一种材料 */
.dock-body {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-l);
  pointer-events: auto;
  /* 整体是拖拽把手：手势期内不让浏览器接管滚动 / 选中 / 长按菜单 */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition:
    transform var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

.dock-body.is-blob {
  width: 64px;
  height: 64px;
  padding: 0;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  border-radius: 20px;
}

/* 抓取反馈：按下轻收、抓住抬升 */
.dock-body.pressing {
  transform: scale(0.97);
}

.wdock-root.immersive-hidden {
  opacity: 0;
  pointer-events: none;
}

/* 收起形变期（closing）：浮条保持可见充当落位底——被不透明的形变壳整个盖住，
   只摘掉折射与交互（折射采样在壳底下无人看见，白付一次全条重采样）。
   落位由 SessionOverlay 的壳面溶解完成显形，这里**没有**入场动画：
   浮条从未离开过自己的位置，任何位移都会让形变落点对不上。 */
.wdock-root.immersive-measuring {
  pointer-events: none;
}

.wdock-root.immersive-measuring .dock-body {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* 条形态：宽度沿用旧悬浮条的视口窄栏（居中由弹簧坐标负责，不靠 margin） */
.dock-body.is-bar {
  width: calc(100vw - 24px);
  max-width: calc(var(--frame-max) - 24px);
}

.dock-body.dragging {
  transform: scale(1.03);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.3);
}

/* 两层内容同位交叉淡变；隐藏层延迟到淡出结束后才真正不可见 */
.layer {
  visibility: visible;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    visibility 0s;
}

.layer.off {
  opacity: 0;
  transform: scale(0.92);
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    visibility 0s linear var(--dur-fast);
}

.layer-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.layer-blob {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.bt {
  max-width: 100%;
  padding: 0 4px;
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 两种显形都由状态类直接驱动 */

/* 左侧信息区：整块可点，等价「恢复沉浸」 */
.info {
  flex: 1;
  min-width: 0;
  gap: 10px;
  text-align: left;
  border-radius: var(--radius-m);
  padding: 2px;
  transition: background var(--dur-fast) var(--ease-standard);
}

.info:active {
  background: var(--surface-2);
}

.dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.live {
  background: var(--c-exercise);
  box-shadow: 0 0 8px color-mix(in srgb, var(--c-exercise) 65%, transparent);
  animation: wbreathe 1.8s infinite;
}

.dot.pause {
  background: var(--warn);
}

@keyframes wbreathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.6);
    opacity: 0.5;
  }
}

.lines {
  min-width: 0;
  gap: 2px;
}

.t {
  font-size: var(--fs-footnote);
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.s {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右侧动作区 */
.acts {
  flex: none;
  gap: 7px;
}

.abtn {
  flex: none;
  height: 38px;
  padding: 0 15px;
  border-radius: 19px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.abtn:active {
  transform: scale(0.94);
}

.abtn.main {
  background: var(--text-1);
  color: var(--bg);
}

.abtn.end {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.abtn.ico {
  width: 38px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

/* 减弱动效：保留透明度确认，去掉一切位移动画与呼吸点 */
@media (prefers-reduced-motion: reduce) {
  .layer,
  .layer.off {
    transform: none;
    transition-duration: 120ms;
  }

  .dock-body {
    transition: none;
  }

  .dot.live {
    animation: none;
  }
}
</style>
