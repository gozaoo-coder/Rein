<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronUp, Square } from 'lucide-vue-next'

import TimeSpine from './TimeSpine.vue'
import { finishSpeaking, restore, voice } from '@/system/voiceRuntime'
import { useDragDock } from '@/composables/useDragDock'

/**
 * 语音转写悬浮条：转写进行中被「⌄ 收起」后常驻（App.vue 挂载）。
 * 与录音浮条/运动条同套 useDragDock 拖拽停靠，但用独立持久化 key；
 * 轻点信息区展开回会话视图，「■ 完成」就地触发整理。
 */
const posEl = ref<HTMLElement | null>(null)
const { slot, form, pressing, dragging, onPointerDown, expandFromBlob } = useDragDock(posEl, {
  storageKey: 'rein.vbar.dock.v1',
})

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 收起态的那根脊：只喂已经定稿的句子，未定稿那句由 head 游标表达 */
const dockSegs = computed(() =>
  voice.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  })),
)
</script>

<template>
  <Transition name="vdock">
    <section
      v-if="voice.minimized && (voice.status === 'recording' || voice.status === 'processing')"
      class="vdock-root"
      :class="[`dock-${slot}`, { dragging }]"
    >
      <div ref="posEl" class="dock-pos">
        <div
          class="dock-body glass-surface"
          :class="[form === 'blob' ? 'is-blob' : 'is-bar', { pressing, dragging }]"
          role="region"
          aria-label="正在转写"
          @pointerdown="onPointerDown"
        >
          <div class="layer layer-bar" :class="{ off: form !== 'bar' }">
            <button class="info" type="button" @click="restore">
              <span class="dot" />
              <b>{{ voice.status === 'recording' ? '转写中' : '整理中' }}</b>
              <span class="s num">{{ fmtMs(voice.elapsedMs) }} · {{ voice.sentences.length }} 句</span>
            </button>
            <!-- 浮条就是那根正在生长的时间脊：收起后也能看出「说到哪、密不密」 -->
            <TimeSpine
              v-if="voice.sentences.length"
              class="barspine"
              size="mini"
              :segments="dockSegs"
              :head-ms="voice.elapsedMs"
            />
            <div class="acts">
              <button v-if="voice.status === 'recording'" class="abtn end" type="button" @click="finishSpeaking">
                <Square :size="11" :stroke-width="2.5" /> 完成
              </button>
              <button class="abtn ico" type="button" aria-label="展开语音会话" @click="restore">
                <ChevronUp :size="15" :stroke-width="2.5" />
              </button>
            </div>
          </div>
          <button
            class="layer layer-blob"
            :class="{ off: form !== 'blob' }"
            type="button"
            aria-label="展开语音会话"
            @click="expandFromBlob"
          >
            <span class="dot" />
            <b class="bt num">{{ fmtMs(voice.elapsedMs) }}</b>
          </button>
        </div>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
/* 与 ActiveWorkoutBar / RecordFloatBar 同构：root 只管 fixed 与 z 序 */
.vdock-root {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 59;
  pointer-events: none;
}

.vdock-root.dragging {
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

/* 浮条里的脊：夹在「转写中 · 时长」与操作按钮之间，是这根条的主体视觉 */
.barspine {
  flex: 1;
  min-width: 44px;
  max-width: 120px;
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
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vdock-enter-active,
.vdock-leave-active {
  transition:
    opacity var(--dur-sheet) var(--ease-sheet),
    transform var(--dur-sheet) var(--ease-sheet);
}

.vdock-enter-from,
.vdock-leave-to {
  opacity: 0;
}

.dock-bottom.vdock-enter-from,
.dock-bottom.vdock-leave-to {
  transform: translateY(18px);
}

.dock-top.vdock-enter-from,
.dock-top.vdock-leave-to {
  transform: translateY(-18px);
}

.dock-left.vdock-enter-from,
.dock-left.vdock-leave-to {
  transform: translateX(-14px);
}

.dock-right.vdock-enter-from,
.dock-right.vdock-leave-to {
  transform: translateX(14px);
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
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
  background: var(--danger);
  box-shadow: 0 0 8px color-mix(in srgb, var(--danger) 65%, transparent);
  animation: vbreathe-dot 1.4s infinite;
}

@keyframes vbreathe-dot {
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

.info b {
  font-size: var(--fs-footnote);
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-1);
  flex: none;
}

.info .s {
  font-size: var(--fs-caption);
  font-weight: 650;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acts {
  flex: none;
  display: flex;
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
  .vdock-enter-from,
  .vdock-leave-to {
    transform: none;
  }

  .vdock-enter-active,
  .vdock-leave-active {
    transition-duration: 150ms;
  }

  .dot {
    animation: none;
  }
}
</style>
