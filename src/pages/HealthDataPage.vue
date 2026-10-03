<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { AlertTriangle, Check, HeartPulse, RefreshCw, ShieldCheck } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { healthSyncService } from '@/services/healthSyncService'
import { nutritionService } from '@/services/nutritionService'
import type { HealthSyncReport, HealthSyncStatus } from '@/types'

/**
 * 第三方数据管理（三级页，入口在「设置 › 第三方数据管理」）。
 *
 * 手机厂商的运动 App（小米运动健康 / 华为运动健康 …）把数据写进**系统的 Health Connect**，
 * 本页让 Rein 从那里读进来、也可以把 Rein 自己记的运动回写出去。
 * 厂商差异在系统那一层就被抹平了，所以这一页只跟 Health Connect 打交道，
 * 不去对接任何厂商私有接口（原理见 Rust `modules/healthsync`）。
 *
 * 页面结构就三张卡，顺序是用户要回答的三个问题：
 *   1. 现在是什么状态（能不能用 / 授权到哪一步）
 *   2. 同步一次会发生什么（以及上一次发生了什么）
 *   3. 这套「谁能改谁」的规则是什么（双向同步必须有明确的所有权，否则用户不敢点）
 *
 * 授权说明：Health Connect 的权限**不是**系统运行时弹窗，点按钮会跳到它自己的界面。
 * 所以这里的每个「去授权」按钮后面都跟着「回来会自己刷新」——用户不必知道该回哪一页。
 */
const { toast } = useToast()

const status = ref<HealthSyncStatus | null>(null)
const report = ref<HealthSyncReport | null>(null)
/** 上一次同步的失败原因：留在页面上，不只闪一条 toast（授权没了这类问题要能反复看） */
const message = ref<string | null>(null)
const loading = ref(true)
const syncing = ref(false)

/** 同步要读全部历史，轮询上限给足；超时是异常路径，正常几秒内就结束 */
const POLL_INTERVAL_MS = 400
const POLL_MAX = 120

const supported = computed(() => status.value?.supported ?? false)
const available = computed(() => status.value?.availability === 'available')
const readGranted = computed(() => status.value?.readGranted ?? false)
const writeGranted = computed(() => status.value?.writeGranted ?? false)
const pushEnabled = computed(() => status.value?.pushEnabled ?? false)

/** 阻塞操作的原因（没有原因 = 可以点「立即同步」） */
const blockedReason = computed(() => {
  if (!supported.value) return '桌面端没有 Health Connect，这个功能只在 Android 手机上可用'
  if (status.value?.availability === 'unknown') return '正在检测本机的 Health Connect…'
  if (status.value?.availability === 'update_required') return '系统的 Health Connect 需要更新后才能使用'
  if (status.value?.availability !== 'available') return '本机没有 Health Connect（Android 14 起才内置）'
  if (!readGranted.value) return '还没有拿到健康数据的读取授权'
  return ''
})

const canSync = computed(() => blockedReason.value === '' && !syncing.value)

const availabilityText: Record<string, string> = {
  available: '可用',
  unavailable: '不可用',
  update_required: '需要更新',
  unknown: '检测中',
}

/** 收敛首次进入时的状态：只在 `unknown` 上继续等，拿到确定答案就停 */
const FIRST_POLL_ATTEMPTS = 10
const FIRST_POLL_INTERVAL_MS = 400

async function refresh() {
  try {
    status.value = await healthSyncService.status()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

/**
 * 把状态读到「真值」为止。
 *
 * 为什么一次读不够：`health_sync_status` 会顺带让原生侧重算授权，但那是**异步**
 * 写文件的，而命令本身读的是文件的现状 —— 也就是说每次读到的是上一轮的答案。
 * 连续问几次就收敛了（真机上两轮以内）。任何「用户可能刚在别处改了授权」的
 * 时机都要走这个循环，而不是单次 refresh。
 */
async function converge() {
  for (let i = 0; i < FIRST_POLL_ATTEMPTS; i++) {
    await refresh()
    const a = status.value?.availability
    if (a !== 'unknown' && a !== undefined) {
      // 可用性已定；授权状态与可用性同一份文件，再补一拍等它写完
      await new Promise((r) => setTimeout(r, FIRST_POLL_INTERVAL_MS))
      await refresh()
      return
    }
    await new Promise((r) => setTimeout(r, FIRST_POLL_INTERVAL_MS))
  }
}

/** 首次进入：原生侧可能还没写过状态文件 */
async function firstLoad() {
  await converge()
}

/** 用户手机当前时区偏移（秒）：导出方向要把「本地日期 + 分钟」折算成 HC 的瞬时时刻 */
function utcOffsetSeconds(): number {
  return -new Date().getTimezoneOffset() * 60
}

/**
 * 估算最大心率：适配层拿它把第三方给的运动心率反推成强度档（`220 - 年龄`）。
 *
 * 两条来源按可信度排：方案计算器里的 `age` 是用户自己填的；`profile.birthday`
 * 是出生年份折算出来的。都没有就返回 null —— 适配层会退回按配速判断，
 * 不会因为缺年龄就写一个编出来的强度。
 */
async function resolveMaxHr(): Promise<number | null> {
  try {
    const calc = await nutritionService.getCalcState()
    if (calc?.age) return 220 - calc.age
  } catch {
    /* 读不到就走下一条 */
  }
  try {
    const profile = await nutritionService.getProfile()
    if (profile.birthday) {
      const born = new Date(profile.birthday)
      const years = (Date.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000)
      if (Number.isFinite(years) && years > 0 && years < 120) return 220 - Math.round(years)
    }
  } catch {
    /* 忽略：拿不到年龄就不按心率判断强度 */
  }
  return null
}

async function authorize(mode: 'read' | 'write') {
  try {
    await healthSyncService.authorize(mode)
    toast('已打开健康数据授权页，授权后返回本页即可')
    // 兜底再补两次延时刷新：授权结果也可能不是经 ActivityResult 回来的
    // （例如用户在 HC 设置页里手动授予），那走不到原生侧的回调，只能靠这里重读
    setTimeout(refresh, 1200)
    setTimeout(refresh, 4000)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

/**
 * 回到前台就重读一次状态。
 *
 * 为什么必须有：授权这一步会把用户**带离**本页（去 Health Connect 的界面），
 * 而回来的路不止一条 —— 系统回调、用户自己从设置页授予、从小米运动健康那边回来。
 * 只靠回调在实现上不可靠，靠 visibilitychange 才是「用户回来了」这件事本身。
 */
function onVisibility() {
  if (document.visibilityState === 'visible') void converge()
}

async function togglePush(next: boolean) {
  try {
    await healthSyncService.setPush(next)
    await refresh()
    if (next && !writeGranted.value) toast('回写还需要「写入」授权，点上面的按钮补一下')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function runSync() {
  if (!canSync.value) return
  syncing.value = true
  report.value = null
  message.value = null
  try {
    const maxHr = await resolveMaxHr()
    const started = await healthSyncService.start(
      pushEnabled.value,
      maxHr,
      utcOffsetSeconds(),
    )
    let step = started
    for (let i = 0; i < POLL_MAX && step.phase === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      step = await healthSyncService.step()
    }
    message.value = step.message
    if (step.message) toast(step.message)
    if (step.report) {
      report.value = step.report
      const total =
        step.report.imported + step.report.updated + step.report.removed +
        step.report.exported + step.report.reExported
      toast(total > 0 ? `同步完成，共处理 ${total} 条` : '同步完成，没有变化')
    } else if (step.phase === 'pending') {
      message.value = '同步超时，请重试'
      toast(message.value)
    }
    await refresh()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    syncing.value = false
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return '从未同步'
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => {
  void firstLoad()
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility))
</script>

<template>
  <div class="page">
    <PageHeader title="第三方数据管理" back />

    <!-- 1. 状态与授权 -->
    <section class="card">
      <h2 class="gtitle">数据源</h2>
      <div class="rows">
        <div class="frow row">
          <i class="fic"><HeartPulse :size="17" /></i>
          <span class="col ftxt">
            <b>Health Connect</b>
            <small>系统健康数据中转站 · 手机厂商的运动 App 都在往这里写</small>
          </span>
          <span class="pill" :class="{ ok: available }">
            {{ availabilityText[status?.availability ?? 'unavailable'] ?? '未知' }}
          </span>
        </div>

        <div v-if="available" class="frow row">
          <i class="fic"><ShieldCheck :size="17" /></i>
          <span class="col ftxt">
            <b>读取授权</b>
            <small>运动记录、消耗、距离、心率</small>
          </span>
          <span v-if="readGranted" class="pill ok"><Check :size="13" /> 已授权</span>
          <button v-else class="act" type="button" @click="authorize('read')">去授权</button>
        </div>

        <div v-if="available && pushEnabled" class="frow row">
          <i class="fic"><ShieldCheck :size="17" /></i>
          <span class="col ftxt">
            <b>写入授权</b>
            <small>把 Rein 记的运动回写给其他 App</small>
          </span>
          <span v-if="writeGranted" class="pill ok"><Check :size="13" /> 已授权</span>
          <button v-else class="act" type="button" @click="authorize('write')">去授权</button>
        </div>
      </div>
    </section>

    <!-- 2. 同步 -->
    <section class="card">
      <h2 class="gtitle">同步</h2>
      <div class="rows">
        <div class="frow row">
          <span class="col ftxt">
            <b>{{ fmtTime(status?.lastSyncAt ?? null) }}</b>
            <small>
              已导入 {{ status?.importedCount ?? 0 }} 条 · 已回写 {{ status?.exportedCount ?? 0 }} 条
            </small>
          </span>
          <button class="act" type="button" :disabled="!canSync" @click="runSync">
            <RefreshCw :size="14" :class="{ spin: syncing }" />
            {{ syncing ? '同步中' : '立即同步' }}
          </button>
        </div>

        <div class="frow row">
          <span class="col ftxt">
            <b>把 Rein 的运动回写出去</b>
            <small>关闭时只读不写；打开后本机补录/课程/跑步也会出现在其他健康 App 里</small>
          </span>
          <ToggleSwitch
            :model-value="pushEnabled"
            label="把 Rein 的运动回写到 Health Connect"
            :disabled="!available || syncing"
            @update:model-value="togglePush"
          />
        </div>

        <p v-if="blockedReason" class="hint">
          <AlertTriangle :size="14" /> {{ blockedReason }}
        </p>
        <!-- 与 blockedReason 并排显示而不是二选一：授权失败的原因必须看得见，
             否则用户只会看到「还没有拿到授权」却不知道刚才那一下为什么没反应 -->
        <p v-if="message" class="hint">
          <AlertTriangle :size="14" /> {{ message }}
        </p>

        <div v-if="report" class="rep">
          <span v-if="report.imported">导入 {{ report.imported }}</span>
          <span v-if="report.updated">更新 {{ report.updated }}</span>
          <span v-if="report.removed">移除 {{ report.removed }}</span>
          <span v-if="report.exported">回写 {{ report.exported }}</span>
          <span v-if="report.reExported">重写 {{ report.reExported }}</span>
          <span v-if="report.skipped">跳过 {{ report.skipped }}（没填开始时间）</span>
          <span v-if="!report.imported && !report.updated && !report.removed && !report.exported && !report.reExported">
            读到 {{ report.scanned }} 条，没有变化
          </span>
        </div>
      </div>
    </section>

    <!-- 3. 规则说明：双向同步必须把「谁能改谁」讲清楚，否则用户不敢点同步 -->
    <section class="card">
      <h2 class="gtitle">同步规则</h2>
      <div class="rows">
        <div class="frow row">
          <span class="col ftxt">
            <b>从手机同步进来的记录</b>
            <small>以 Health Connect 为准：那边改了会覆盖这边，那边删了这边也跟着删</small>
          </span>
        </div>
        <div class="frow row">
          <span class="col ftxt">
            <b>Rein 自己记的运动</b>
            <small>以本机为准；删除时会连带收掉回写出去的那一份</small>
          </span>
        </div>
        <div class="frow row">
          <span class="col ftxt">
            <b>在这里删掉一条同步记录</b>
            <small>只从 Rein 移除，不删 Health Connect 里那份（它可能是别的 App 写的）</small>
          </span>
        </div>
      </div>
    </section>

    <!-- 引导流程的落点（未授权时该去哪一步、怎么在小米运动健康里开启数据共享）
         由用户自己实现，见记忆 rein-third-party-health-data 的说明。 -->
  </div>
</template>

<style scoped>
/* 三级页的标准骨架（与设置页 / 同步页同一套）：
   .page 管画布留白，.gtitle 是卡内分组标题 —— 两者都是页面私有的 scoped 类，
   全局没有兜底，漏写就会退化成浏览器默认的 h2 大黑标题。 */
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.gtitle {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.rows {
  display: flex;
  flex-direction: column;
  margin-top: 4px;
}

.frow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
}

.frow + .frow {
  border-top: 0.5px solid var(--line);
}

.fic {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-s);
  background: var(--accent-soft);
  color: var(--accent);
}

.ftxt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-1);
}

.ftxt small {
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: 1.4;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.pill.ok {
  background: var(--ok-soft);
  color: var(--ok);
}

.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  min-height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  cursor: pointer;
}

.act:disabled {
  opacity: 0.45;
  cursor: default;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 2px;
  color: var(--warn);
  font-size: var(--fs-caption);
}

.rep {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  color: var(--text-2);
  font-size: var(--fs-caption);
}
</style>
