<script setup lang="ts">
/**
 * AiStreamingText — 句子级流式文字动画组件
 *
 * 行为：
 * - 流式期间（isPending=true）：按中文/英文标点分割句子，
 *   每个句子完成后以淡入动画弹出显示，当前未完成的句子带闪烁光标。
 * - 完成后（isPending=false）：一次性显示全部文本（父组件负责 markdown 渲染）。
 */
import { computed, nextTick, ref, watch } from "vue";
import { useAnime } from "@/composables/useAnime";

const props = defineProps<{
  text: string;
  isPending: boolean;
}>();

/** 匹配一个句子：以标点结尾的一段文字，或行末无标点的剩余文字 */
const SENTENCE_RE = /([^。！？，；：、\n.!?,;:\n]+(?:[。！？，；：、\n.!?,;:\n]|$))/g;

function splitSentences(raw: string): string[] {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = SENTENCE_RE.exec(raw)) !== null) {
    // 捕获非空段落之间的空白也纳入前一段
    const gap = raw.slice(lastEnd, match.index);
    if (gap && parts.length > 0) {
      parts[parts.length - 1] += gap;
    }
    parts.push(match[1]);
    lastEnd = match.index + match[1].length;
  }
  // 末尾残段（无标点结尾的未完成句子）
  const trailing = raw.slice(lastEnd);
  if (trailing) {
    parts.push(trailing);
  }
  return parts;
}

const committed = ref<string[]>([]);
const draft = ref("");
/** 标记：首次渲染时跳过动画（立即显示已有内容） */
const isFirstRender = ref(true);

watch(
  () => props.text,
  (newText) => {
    if (!props.isPending) {
      // 完成态：全部展示
      committed.value = [newText];
      draft.value = "";
      return;
    }

    const sentences = splitSentences(newText);

    if (sentences.length === 0) {
      committed.value = [];
      draft.value = "";
      return;
    }

    // 最后一段 => 草稿（若以标点结尾则提交为完整句）
    const last = sentences[sentences.length - 1];
    const isComplete = /[。！？，；：、\n.!?,;:\n]$/.test(last);

    if (isComplete) {
      committed.value = sentences;
      draft.value = "";
    } else {
      committed.value = sentences.slice(0, -1);
      draft.value = last;
    }
  },
  { immediate: true },
);

/** 当前帧需要播放动画的句子索引（跳过首帧已有） */
const animateFrom = ref(0);

watch(
  committed,
  (val, old) => {
    if (isFirstRender.value) {
      animateFrom.value = val.length;
      isFirstRender.value = false;
      return;
    }
    // 新提交的句子播放动画
    animateFrom.value = old?.length ?? 0;
  },
  { immediate: true },
);

// ===== 流式光标（anime.js 驱动闪烁） =====
const rootRef = ref<HTMLElement | null>(null);
const cursorRef = ref<HTMLElement | null>(null);
const { animate, reduced } = useAnime(rootRef);

/** 光标可见性：流式中显示，流式结束淡出后移除 */
const showCursor = ref(false);
let blinkInst: ReturnType<typeof animate> | null = null;

/** 启动光标闪烁（macOS 风格 530ms 半周期，1060ms 完整循环） */
async function startBlink() {
  await nextTick();
  const el = cursorRef.value;
  if (!el) return;
  if (reduced.value) {
    // reduced-motion：常亮不闪烁
    el.style.opacity = "1";
    return;
  }
  blinkInst = animate(el, {
    opacity: [1, 0, 1],
    duration: 1060,
    loop: true,
    ease: "inOutSine",
  });
}

/** 停止闪烁并淡出移除光标 */
function stopBlink() {
  const el = cursorRef.value;
  if (blinkInst) {
    blinkInst.pause();
    blinkInst = null;
  }
  if (!el || reduced.value) {
    showCursor.value = false;
    return;
  }
  animate(el, {
    opacity: 0,
    duration: 200,
    ease: "outQuad",
    onComplete: () => {
      showCursor.value = false;
    },
  });
}

watch(
  () => props.isPending,
  (pending) => {
    if (pending) {
      showCursor.value = true;
      void startBlink();
    } else {
      stopBlink();
    }
  },
  { immediate: true },
);
</script>

<template>
  <div ref="rootRef" class="streaming-text" :class="{ pending: isPending }">
    <template v-if="isPending">
      <!-- 已完成句子 -->
      <span
        v-for="(seg, i) in committed"
        :key="'c' + i"
        class="sentence-done"
        :class="{ 'sentence-enter': i >= animateFrom }"
      >{{ seg }}</span>
      <!-- 当前草稿 -->
      <span v-if="draft" class="sentence-draft">{{ draft }}</span>
    </template>
    <!-- 非流式：显示原始文本（父组件处理 markdown） -->
    <template v-else>
      <span class="sentence-done">{{ text }}</span>
    </template>
    <!-- 流式光标：独立于 isPending 块，便于 anime.js 控制 + 淡出移除 -->
    <span v-if="showCursor" ref="cursorRef" class="cursor" aria-hidden="true">|</span>
  </div>
</template>

<style scoped>
.streaming-text {
  font-size: var(--text-sm);
  line-height: 1.6;
  word-break: break-word;
}

.sentence-done {
  display: inline;
  opacity: 1;
}

/* 句子淡入上移动画 */
.sentence-enter {
  animation: sentence-pop 0.45s var(--ease-immersive) both;
}

@keyframes sentence-pop {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.sentence-draft {
  display: inline;
  color: var(--color-text);
}

/* 闪烁光标（闪烁由 anime.js 驱动；reduced-motion 下常亮） */
.cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--color-warm);
  margin-left: 1px;
  vertical-align: text-bottom;
  opacity: 1;
}
</style>
