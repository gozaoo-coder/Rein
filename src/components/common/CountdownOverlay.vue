<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * 全屏覆盖层：训练开始提示。
 * - countFrom > 0：3·2·1 →「GO!」倒数（计时动作开始前）
 * - countFrom = 0：直接闪现 label（如「开始第 3 组」）
 * 结束后 emit('done') 并自动隐藏。
 * immediate：沉浸页可能在 overlay 已 show 的状态下才挂载（悬浮运动条
 * 完成组后 store 侧触发了 flash），挂载即接管倒计时而不是卡在静态层。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    countFrom?: number
    label?: string
    sub?: string
  }>(),
  { countFrom: 3, label: '', sub: '' },
)

const emit = defineEmits<{ done: [] }>()

const text = ref('')
const isGo = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(
  () => props.show,
  (show) => {
    stopTimer()
    if (!show) return

    if (props.countFrom > 0) {
      let n = props.countFrom
      isGo.value = false
      text.value = String(n)
      timer = setInterval(() => {
        n--
        if (n >= 1) {
          text.value = String(n)
        } else {
          stopTimer()
          isGo.value = true
          text.value = 'GO!'
          setTimeout(() => emit('done'), 800)
        }
      }, 1000)
    } else {
      isGo.value = true
      text.value = props.label || 'GO!'
      setTimeout(() => emit('done'), 1200)
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="ov-fade">
      <div v-if="show" class="overlay col center">
        <p class="sub">{{ sub }}</p>
        <!-- :key 触发重新挂载，让 pop 动画每个数字都播放 -->
        <b :key="text" class="big" :class="{ go: isGo }">{{ text }}</b>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 105;
  gap: 14px;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
}

.big {
  font-size: 88px;
  font-weight: 200;
  letter-spacing: -3px;
  line-height: 1;
  animation: ov-pop 550ms var(--ease-standard);
}

.big.go {
  color: var(--c-intake);
  font-weight: 300;
  text-shadow: 0 0 40px rgba(250, 17, 79, 0.35);
}

.sub {
  font-size: var(--fs-callout);
  font-weight: 500;
  color: var(--text-2);
}

@keyframes ov-pop {
  0% {
    transform: scale(0.4);
    opacity: 0;
  }
  55% {
    transform: scale(1.18);
    opacity: 1;
  }
  100% {
    transform: scale(1);
  }
}

.ov-fade-enter-active,
.ov-fade-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.ov-fade-enter-from,
.ov-fade-leave-to {
  opacity: 0;
}
</style>
