<script setup lang="ts">
import { ref } from 'vue'
import { Sparkles } from 'lucide-vue-next'

import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'

/** AI 智能调整：一句话生成目标修改建议，确认后才生效。 */
const ai = useAiStore()
const { toast } = useToast()

const draft = ref('')

const EXAMPLES = ['热量降到 1800 大卡', '蛋白质提高到 130 克', '钠减到 1200，饮水加到 2400']

async function submit(): Promise<void> {
  if (!draft.value.trim() || ai.busy) return
  try {
    await ai.requestTargetAdjust(draft.value)
    draft.value = ''
  } catch {
    toast('解析失败了，请换个说法试试')
  }
}

async function adopt(): Promise<void> {
  try {
    await ai.applyTargetProposal()
    toast('新目标已生效')
  } catch {
    toast('保存失败，请重试')
  }
}

function dismiss(): void {
  ai.dismissTargetProposal()
}
</script>

<template>
  <section class="card">
    <header class="head">
      <h2 class="row center"><Sparkles :size="16" class="ic" />AI 智能调整</h2>
      <p class="t-3">一句话描述 · AI 给出可确认的新目标</p>
    </header>

    <!-- 输入 -->
    <div class="inbar row">
      <input
        v-model="draft"
        type="text"
        placeholder="如：热量降到1800，蛋白质提到130"
        aria-label="描述目标调整"
        @keydown.enter="submit"
      >
      <button class="send" aria-label="生成调整建议" :disabled="ai.busy || !draft.trim()" @click="submit">
        {{ ai.busy ? '…' : '生成' }}
      </button>
    </div>

    <!-- 示例 -->
    <ul class="ex row">
      <li v-for="e in EXAMPLES" :key="e">
        <button class="ex-chip" :disabled="ai.busy" @click="draft = e">{{ e }}</button>
      </li>
    </ul>

    <!-- 建议卡 -->
    <div v-if="ai.targetProposal" class="proposal">
      <p class="reply">{{ ai.targetProposal.reply }}</p>
      <ul v-if="ai.targetProposal.changes.length" class="changes">
        <li v-for="c in ai.targetProposal.changes" :key="c.field" class="row between">
          <span class="cl">{{ c.label }}</span>
          <span class="num cv">
            {{ Math.round(c.from) }} → <b>{{ Math.round(c.to) }}</b><i>{{ c.unit }}</i>
          </span>
        </li>
      </ul>
      <div v-if="ai.targetProposal.changes.length" class="acts row">
        <button class="ghost-btn" @click="dismiss">放弃</button>
        <button class="apply" @click="adopt">采用新方案</button>
      </div>
      <button v-else class="ghost-btn wide" @click="dismiss">知道了</button>
    </div>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
  gap: 6px;
}

.ic {
  color: var(--accent);
}

.head p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}

/* 输入栏 */
.inbar {
  gap: 8px;
  margin-top: 14px;
  padding: 6px 6px 6px 14px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.inbar input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.inbar input::placeholder {
  color: var(--text-3);
}

.send {
  flex: none;
  padding: 9px 16px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.send:disabled {
  opacity: 0.35;
}

/* 示例 */
.ex {
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.ex-chip {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 0.5px solid var(--line-strong);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.ex-chip:disabled {
  opacity: 0.5;
}

/* 建议卡 */
.proposal {
  margin-top: 14px;
  padding: 13px 14px;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
}

.reply {
  font-size: var(--fs-footnote);
  line-height: 1.55;
  color: var(--text-2);
}

.changes {
  margin-top: 10px;
  background: var(--surface);
  border-radius: var(--radius-s);
  padding: 2px 12px;
}

.changes li {
  padding: 9px 0;
}

.changes li + li {
  border-top: 0.5px solid var(--line);
}

.cl {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.cv {
  font-size: var(--fs-subhead);
  color: var(--text-3);
}

.cv b {
  color: var(--accent);
  font-weight: 700;
}

.cv i {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 1px;
}

.acts {
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}

.ghost-btn {
  padding: 9px 18px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
}

.ghost-btn.wide {
  width: 100%;
  margin-top: 10px;
}

.apply {
  padding: 9px 18px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}
</style>
