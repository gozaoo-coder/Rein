<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Expand, Square } from 'lucide-vue-next'

import { fmtDur, recorder, stopRecording } from '@/system/recorderRuntime'
import { useDragDock } from '@/composables/useDragDock'

/**
 * 录音悬浮条：录音进行中常驻（App.vue 挂载，沉浸形态隐藏）。
 * 与 ActiveWorkoutBar 同一套拖拽停靠（useDragDock），但用独立的
 * 持久化 key——两条各停各位，互不挤占。条形态：呼吸红点 + 计时 +
 * 停止 / 打开录音页；轻点信息区进 /record 录音页，拖到左右边缘
 * 收成 64px 方块泊车，轻点展开回条。录音是全局 runtime：从编辑
 * 抽屉或录音页发起的录音，切页后都由本条接管。
 */
const router = useRouter()

const posEl = ref<HTMLElement | null>(null)
const { slot, form, pressing, dragging, onPointerDown, expandFromBlob } = useDragDock(posEl, {
  storageKey: 'rein.rbar.dock.v1',
})

function openPage(): void {
  void router.push('/record')
}
</script>

<template>
  <Transition name="rdock">
    <section
      v-if="recorder.status === 'recording'"
      class="rdock-root"
      :class="[`dock-${slot}`, { dragging }]"
    >
      <div ref="posEl" class="dock-pos">
        <div
          class="dock-body glass-surface"
          :class="[form === 'blob' ? 'is-blob' : 'is-bar', { pressing, dragging }]"
          role="region"
          aria-label="正在录音"
          @pointerdown="onPointerDown"
        >
          <!-- 全宽条形态 -->
          <div class="layer layer-bar" :class="{ off: form !== 'bar' }">
            <button class="info row" type="button" @click="openPage">
              <span class="dot live" />
              <b class="t">录音中</b>
              <span class="s num">{{ fmtDur(recorder.elapsedSec) }}</span>
            </button>
            <div class="acts row">
              <button class="abtn end" type="button" @click="stopRecording">
                <Square :size="13" :stroke-width="2.5" /> 停止
              </button>
              <button class="abtn ico" type="button" aria-label="打开录音页" @click="openPage">
                <Expand :size="15" :stroke-width="2.5" />
              </button>
            </div>
          </div>

          <!-- 方块泊车形态：轻点展开回全宽条 -->
          <button
            class="layer layer-blob"
            :class="{ off: form !== 'blob' }"
            type="button"
            aria-label="展开录音控制"
            @click="expandFromBlob"
          >
            <span class="dot live" />
            <b class="bt num">{{ fmtDur(recorder.elapsedSec) }}</b>
          </button>
        </div>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
/* 与 ActiveWorkoutBar 同构：root 只管 fixed 与 z 序，位移在 .dock-pos */
.rdock-root {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 59;
  pointer-events: none;
}

.rdock-root.dragging {
  z-index: 70;
}

.dock-pos {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}

/* 材质走全局 .glass-surface（与底部 Dock 同一份定义），这里只留几何与手感 */
.dock-body {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-l);
  pointer-events: auto;
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

.dock-body.pressing {
  transform: scale(0.97);
}

.dock-body.is-bar {
  width: calc(100vw - 24px);
  max-width: calc(var(--frame-max) - 24px);
}

.dock-body.dragging {
  transform: scale(1.03);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.3);
}

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

.rdock-enter-active,
.rdock-leave-active {
  transition:
    opacity var(--dur-sheet) var(--ease-sheet),
    transform var(--dur-sheet) var(--ease-sheet);
}

.rdock-enter-from,
.rdock-leave-to {
  opacity: 0;
}

.dock-bottom.rdock-enter-from,
.dock-bottom.rdock-leave-to {
  transform: translateY(18px);
}

.dock-top.rdock-enter-from,
.dock-top.rdock-leave-to {
  transform: translateY(-18px);
}

.dock-left.rdock-enter-from,
.dock-left.rdock-leave-to {
  transform: translateX(-14px);
}

.dock-right.rdock-enter-from,
.dock-right.rdock-leave-to {
  transform: translateX(14px);
}

.info {
  flex: 1;
  min-width: 0;
  gap: 9px;
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
}

.dot.live {
  background: var(--danger);
  box-shadow: 0 0 8px color-mix(in srgb, var(--danger) 65%, transparent);
  animation: rbreathe 1.4s infinite;
}

@keyframes rbreathe {
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

.t {
  font-size: var(--fs-footnote);
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-1);
}

.s {
  font-size: var(--fs-caption);
  font-weight: 650;
  color: var(--text-2);
}

.acts {
  flex: none;
  gap: 7px;
}

.abtn {
  flex: none;
  height: 34px;
  padding: 0 13px;
  border-radius: 17px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.abtn:active {
  transform: scale(0.94);
}

.abtn.end {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.abtn.ico {
  width: 34px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .rdock-enter-from,
  .rdock-leave-to {
    transform: none;
  }

  .rdock-enter-active,
  .rdock-leave-active {
    transition-duration: 150ms;
  }

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
