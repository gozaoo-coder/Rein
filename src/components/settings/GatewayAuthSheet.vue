<script setup lang="ts">
import { computed, ref, watch, type DeepReadonly } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { externalAccessRuntime } from '@/system/externalAccessRuntime'
import {
  GATEWAY_SCOPES,
  GATEWAY_SCOPE_LABELS,
  type GatewayAuthDecision,
  type GatewayAuthRequest,
  type GatewayScope,
} from '@/types'

/**
 * 外部程序授权弹窗（全局常驻层，App.vue 挂载，无 props —— 状态来自单例 runtime）。
 *
 * 四态按钮语义独立（contract §5.1、§8.3）：允许本次会话 / 始终允许 / 忽略 / 拒绝。
 * 「不做静默通过」：抽屉的 × / 背景 / Esc 一律等同「忽略」——不落决策、连接保持
 * pending，程序既没拿到数据、也没被永久拒绝。
 *
 * **逐项勾选**（contract §5.3）：7 条 scope 全部列成可勾选行，默认只勾请求方建议的
 * 最小集（通常是 `schedule.read`）；写权限必须用户显式勾上，`decide` 回传的是勾选集
 * 而不是服务端的建议集 —— 否则除只读日程外任何权限都授不出去。
 *
 * 超时不在这里自己计时：runtime 按 `request.timeoutMs` 计并自动按「忽略」上报，
 * 本组件只负责把「多久后会自动忽略」如实告诉用户。
 */
const live = computed(() => externalAccessRuntime.state.current)
/** 抽屉离场动画期间保留最后一条请求，避免滑出时内容已经空了。 */
const cached = ref<DeepReadonly<GatewayAuthRequest> | null>(null)
watch(live, (v) => {
  if (v) cached.value = v
})
const open = computed(() => live.value !== null)
const request = computed(() => live.value ?? cached.value)

/** 用户当前勾选的 scope 集（默认 = 请求方建议的最小集）。 */
const selected = ref<Set<string>>(new Set())
watch(
  live,
  (v) => {
    selected.value = new Set(v ? v.scopes : [])
  },
  { immediate: true },
)

function toggle(s: GatewayScope): void {
  const next = new Set(selected.value)
  if (next.has(s)) next.delete(s)
  else next.add(s)
  selected.value = next
}

/** 展示给用户的超时提示秒数（协议默认 30s）。 */
const timeoutSec = computed(() => Math.max(1, Math.round((request.value?.timeoutMs ?? 30_000) / 1000)))

function decide(decision: GatewayAuthDecision, scopes?: string[]): void {
  void externalAccessRuntime.decide(decision, scopes)
}

/** 放行类按钮：把用户勾选集（按 Scope::ALL 的展示顺序）回传。 */
function decideAllow(decision: 'allow-session' | 'allow-always'): void {
  decide(decision, GATEWAY_SCOPES.filter((s) => selected.value.has(s)))
}

/** 未收录的新 scope 原样显示串（后端已按白名单过滤，兜底只为不吞信息）。 */
function scopeLabel(s: string): string {
  return GATEWAY_SCOPE_LABELS[s as GatewayScope] ?? s
}
</script>

<template>
  <SheetModal :open="open" title="外部程序请求访问" @close="decide('ignore')">
    <div v-if="request" class="wrap" data-testid="gateway-auth-sheet">
      <div class="who">
        <b class="cname">{{ request.clientName }}</b>
        <code v-if="request.ip" class="origin">来自 {{ request.ip }}</code>
        <code v-else-if="request.origin" class="origin">{{ request.origin }}</code>
      </div>
      <p class="lead t-3">
        勾选要授予的权限（默认只给「查看日程」）。写权限请按需勾上，只有勾了的才会授出去。
        授权只对这一个客户端的本次连接生效，并不影响其他程序。
      </p>
      <div class="card sub rows">
        <button
          v-for="s in GATEWAY_SCOPES"
          :key="s"
          type="button"
          class="scope"
          :class="{ on: selected.has(s) }"
          :aria-pressed="selected.has(s)"
          :data-testid="`gateway-auth-scope-${s}`"
          @click="toggle(s)"
        >
          <span class="sname">{{ scopeLabel(s) }}</span>
          <code class="scode t-3">{{ s }}</code>
          <span class="check" aria-hidden="true">{{ selected.has(s) ? '✓' : '' }}</span>
        </button>
      </div>
      <p class="hint t-3">
        「允许本次会话」在程序关闭后失效；「始终允许」是长期授权，可随时在设置里撤销。
        {{ timeoutSec }} 秒内不选择将按「忽略」处理。
      </p>
    </div>

    <template #footer>
      <div class="acts">
        <button class="btn" data-testid="gateway-auth-ignore" @click="decide('ignore')">忽略</button>
        <button class="btn danger" data-testid="gateway-auth-deny" @click="decide('deny')">拒绝</button>
        <button class="btn" data-testid="gateway-auth-allow-session" @click="decideAllow('allow-session')">
          允许本次会话
        </button>
        <button class="btn primary" data-testid="gateway-auth-allow-always" @click="decideAllow('allow-always')">
          始终允许
        </button>
      </div>
    </template>
  </SheetModal>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
}

.who {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 10px;
}

.cname {
  font-size: var(--fs-headline);
  font-weight: 700;
}

.origin {
  font-size: var(--fs-caption);
  color: var(--text-3);
  word-break: break-all;
}

.lead {
  line-height: 1.6;
  margin-bottom: 10px;
}

/* 行间细线，首行不留线（与设置页 .rows 同一条分组规则） */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

.scope {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 9px 0;
  background: none;
  border: 0;
  text-align: left;
  color: inherit;
  cursor: pointer;
}

.scope.on .sname {
  color: var(--accent);
}

.check {
  flex: none;
  width: 1.2em;
  text-align: right;
  color: var(--accent);
  font-weight: 700;
}

.sname {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.scode {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.hint {
  margin-top: 12px;
  line-height: 1.6;
}

/* 四态按钮：两行两列，语义同类相邻（上排「不放行」，下排「放行」） */
.acts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: 600;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.btn:active {
  transform: scale(0.985);
}

.btn.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}
</style>
