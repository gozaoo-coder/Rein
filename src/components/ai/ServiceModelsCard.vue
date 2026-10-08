<script setup lang="ts">
/**
 * 服务模型卡：全应用四个模型接口的「当前用哪个」一屏看全，点一行换一个。
 *
 * 四行的真源各不相同（见 stores/modelRoles）：
 * - 主 LLM → ai_models 的默认项；多模态备选 → 界面偏好里的绑定（只在主模型没有
 *   视觉能力时才需要，否则这一行暗着并说明原因）；
 * - ASR → 语音配置；向量 → 知识库设置。
 *
 * 所以这张卡只做「读 + 点开选择」，不在这里改任何配置 —— 换模型的动作全部落到
 * 各自的执行位（选完立即生效，页面回读的就是新值）。
 */
import { Boxes, Eye, MessageSquareText, Mic } from 'lucide-vue-next'

import { useModelRolesStore } from '@/stores/modelRoles'
import type { ModelRole } from '@/types'

defineProps<{ loading?: boolean }>()

const emit = defineEmits<{ pick: [ModelRole] }>()

const roles = useModelRolesStore()

const ICONS = {
  llm: MessageSquareText,
  vision: Eye,
  asr: Mic,
  embedding: Boxes,
} as const
</script>

<template>
  <section class="card sm">
    <div class="row between center head">
      <b>服务模型</b>
      <span class="t-3 sub">聊天 · 看图 · 语音识别 · 语义检索</span>
    </div>

    <ul>
      <li v-for="s in roles.slots" :key="s.role">
        <button
          type="button"
          class="row center slot"
          :class="{ locked: !s.interactive }"
          :disabled="!s.interactive || loading"
          @click="emit('pick', s.role)"
        >
          <span class="ic" :class="`ic-${s.role}`">
            <component :is="ICONS[s.role]" :size="15" />
          </span>
          <span class="flex-1 min0 txt">
            <span class="row center t1">
              <i class="label">{{ s.label }}</i>
              <i v-if="s.ok" class="dot ok" aria-label="已就绪" />
              <i v-else class="dot warn" aria-label="未就绪" />
            </span>
            <b>{{ s.value }}</b>
            <small>{{ s.sub }}</small>
            <em v-if="s.warn" class="warn-line">{{ s.warn }}</em>
            <em v-else-if="s.lockedNote" class="lock-line">{{ s.lockedNote }}</em>
          </span>
          <span class="go">›</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sm {
  padding: 13px 14px;
}

.head {
  gap: 8px;
}

.head b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.head .sub {
  font-size: var(--fs-micro);
}

ul {
  margin-top: 6px;
}

.slot {
  gap: 11px;
  width: 100%;
  padding: 11px 0;
  text-align: left;
}

.slot + .slot,
li + li .slot {
  border-top: 0.5px solid var(--line);
}

.slot:disabled {
  opacity: 0.6;
}

.slot.locked .go {
  visibility: hidden;
}

.ic {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-s);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.ic-llm {
  background: linear-gradient(135deg, #2f6bff, #5ac8fa);
}

.ic-vision {
  background: linear-gradient(135deg, #7c5cff, #b48bff);
}

.ic-asr {
  background: linear-gradient(135deg, #0a84ff, #1eeaef);
}

.ic-embedding {
  background: linear-gradient(135deg, #ff9f0a, #ffd60a);
}

.txt {
  min-width: 0;
}

.t1 {
  gap: 6px;
}

.label {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-3);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.dot.ok {
  background: var(--ok);
}

.dot.warn {
  background: var(--text-3);
}

.txt b {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-subhead);
  font-weight: 700;
  word-break: break-all;
}

.txt small {
  display: block;
  margin-top: 2px;
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: 1.45;
  word-break: break-all;
}

.warn-line,
.lock-line {
  display: block;
  margin-top: 3px;
  font-style: normal;
  font-size: var(--fs-micro);
  line-height: 1.45;
}

.warn-line {
  color: var(--danger, #ff5257);
}

.lock-line {
  color: var(--text-3);
}

.go {
  flex: none;
  color: var(--text-3);
  font-size: 17px;
}
</style>
