<script setup lang="ts">
/**
 * SyncPage — P2P 局域网同步设置
 *
 * - 本机信息 / 匹配码 / 已配对设备 / 在线设备 / 数据记录
 * - 监听 Tauri 事件：sync-device-discovered / sync-pair-request /
 *   sync-pair-success / sync-pair-rejected / sync-records-updated
 * - Web 环境降级展示，不订阅事件
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { listen } from "@tauri-apps/api/event";
import { useSync } from "@/composables/useSync";
import type {
  DiscoveredDevice,
  PairedDevice,
  PairCodeInfo,
} from "@/composables/useSync";
import { useToast } from "@/composables/useToast";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const router = useRouter();
const toast = useToast();
const {
  onlineDevices,
  pairedDevices,
  records,
  deviceInfo,
  pairCode,
  refreshAll,
  refreshPairCode,
  pairRequest,
  pairRespond,
  unpair,
  upsertRecord,
  deleteRecord,
} = useSync();

// ====== 状态 ======
const targetCode = ref("");
const targetDeviceId = ref("");
const recordsCollapsed = ref(true);

interface PairRequestPayload {
  from_id: string;
  from_name: string;
  from_ip?: string;
  from_port?: number;
}
const pairRequestModal = ref<PairRequestPayload | null>(null);

// ====== 计算属性 ======
const unpairedTargets = computed(() =>
  onlineDevices.value.filter(
    (d) => !d.paired && d.device_id !== deviceInfo.value?.device_id,
  ),
);

const targetDevice = computed(
  () =>
    onlineDevices.value.find((d) => d.device_id === targetDeviceId.value) ??
    null,
);

const canPair = computed(
  () => targetCode.value.length === 6 && !!targetDevice.value,
);

// ====== 工具方法 ======
function goBack() {
  router.back();
}

function truncateId(id: string, head = 8, tail = 4): string {
  if (!id) return "--";
  if (id.length <= head + tail) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function codeProgress(c: PairCodeInfo): number {
  if (c.ttl <= 0) return 0;
  return Math.max(0, Math.min(1, c.remaining_secs / c.ttl));
}

function fmtTime(ts: number): string {
  if (!ts) return "--";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function copyDeviceId() {
  if (!deviceInfo.value?.device_id) return;
  try {
    await navigator.clipboard.writeText(deviceInfo.value.device_id);
    toast.success("已复制设备 ID");
  } catch {
    toast.warning("复制失败");
  }
}

function onCodeInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
    .replace(/\D/g, "")
    .slice(0, 6);
  targetCode.value = v;
}

// ====== 配对流程 ======
async function handlePair() {
  if (!canPair.value || !targetDevice.value) return;
  try {
    await pairRequest(
      targetDevice.value.device_id,
      targetDevice.value.ip,
      targetDevice.value.port,
      targetCode.value,
    );
    toast.info("已发起配对请求");
  } catch (e) {
    toast.error("配对请求失败");
    console.warn(e);
  }
}

async function handleUnpair(d: PairedDevice) {
  try {
    await unpair(d.device_id);
    toast.success(`已取消与 ${d.name} 的配对`);
  } catch (e) {
    toast.error("取消配对失败");
    console.warn(e);
  }
}

function selectTarget(d: DiscoveredDevice) {
  targetDeviceId.value = d.device_id;
  document
    .querySelector(".pair-code-card")
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function respondPair(accept: boolean) {
  const req = pairRequestModal.value;
  if (!req) return;
  let ip = req.from_ip ?? "";
  let port = req.from_port ?? 0;
  if (!ip) {
    const found = onlineDevices.value.find((d) => d.device_id === req.from_id);
    if (found) {
      ip = found.ip;
      port = found.port;
    }
  }
  pairRequestModal.value = null;
  try {
    await pairRespond(req.from_id, req.from_name, ip, port, accept);
  } catch (e) {
    toast.error("响应配对失败");
    console.warn(e);
  }
}

// ====== 数据记录 ======
async function addTestRecord() {
  const n = records.value.length + 1;
  try {
    await upsertRecord(`test-${Date.now()}`, `测试记录 ${n}`);
    toast.success("已新增测试记录");
  } catch (e) {
    toast.error("新增记录失败");
    console.warn(e);
  }
}

async function handleDeleteRecord(id: string) {
  try {
    await deleteRecord(id);
    toast.success("已删除记录");
  } catch (e) {
    toast.error("删除记录失败");
    console.warn(e);
  }
}

// ====== 事件订阅 ======
const unlisteners: Array<() => void> = [];
let codeTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  if (!isTauri) return;
  try {
    unlisteners.push(
      await listen("sync-device-discovered", () => {
        void refreshAll();
      }),
      await listen<{ from_id: string; from_name: string }>(
        "sync-pair-request",
        (e) => {
          pairRequestModal.value = {
            from_id: e.payload.from_id,
            from_name: e.payload.from_name,
          };
        },
      ),
      await listen("sync-pair-success", () => {
        toast.success("配对成功");
        void refreshAll();
      }),
      await listen("sync-pair-rejected", () => {
        toast.warning("配对请求被拒绝");
      }),
      await listen("sync-records-updated", () => {
        void refreshAll();
      }),
    );
  } catch (e) {
    console.warn("sync event subscribe failed", e);
  }
  codeTimer = setInterval(() => {
    void refreshPairCode();
  }, 5000);
  void refreshAll();
  void refreshPairCode();
});

onUnmounted(() => {
  for (const fn of unlisteners) {
    try {
      fn();
    } catch {
      /* noop */
    }
  }
  if (codeTimer) clearInterval(codeTimer);
});
</script>

<template>
  <div class="sync-page">
    <!-- 子标题栏 -->
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">P2P 同步</h2>
    </header>

    <!-- 本机信息卡 -->
    <section class="clean-card info-card">
      <div class="info-row">
        <div class="info-name">
          {{ deviceInfo?.device_name ?? "未命名设备" }}
        </div>
        <span
          class="status-badge"
          :class="isTauri ? 'badge-success' : 'badge-muted'"
        >
          {{ isTauri ? "局域网 P2P 已启动" : "仅 Tauri 可用" }}
        </span>
      </div>
      <button class="device-id-row" @click="copyDeviceId">
        <span class="device-id-label">设备 ID</span>
        <span class="device-id-value">{{
          truncateId(deviceInfo?.device_id ?? "--")
        }}</span>
        <span class="copy-hint">点击复制</span>
      </button>
    </section>

    <!-- 匹配码卡 -->
    <section class="clean-card pair-code-card">
      <div class="card-title">匹配码</div>
      <div class="pair-code-display">
        {{ pairCode?.code ?? "------" }}
      </div>
      <div class="countdown-track">
        <div
          class="countdown-bar"
          :style="{
            width: pairCode
              ? `${codeProgress(pairCode) * 100}%`
              : '0%',
          }"
        ></div>
      </div>
      <div class="pair-hint">
        每 30 秒滚动更新 · 5 分钟内不可重复请求同一设备
      </div>

      <div class="pair-form">
        <label class="form-label" for="target-code">对方匹配码</label>
        <input
          id="target-code"
          class="code-input"
          type="text"
          inputmode="numeric"
          :maxlength="6"
          :value="targetCode"
          placeholder="6 位数字"
          @input="onCodeInput"
        />

        <label class="form-label" for="target-device">目标设备</label>
        <select id="target-device" v-model="targetDeviceId" class="target-select">
          <option value="">请选择设备</option>
          <option
            v-for="d in unpairedTargets"
            :key="d.device_id"
            :value="d.device_id"
          >
            {{ d.name }} ({{ d.ip }})
          </option>
        </select>

        <button class="pair-btn" :disabled="!canPair" @click="handlePair">
          发起配对
        </button>
      </div>
    </section>

    <!-- 已配对设备卡 -->
    <section class="clean-card paired-card">
      <div class="card-title">已配对设备</div>
      <div v-if="pairedDevices.length === 0" class="empty-text">
        暂无配对设备
      </div>
      <div v-else class="device-list">
        <div
          v-for="d in pairedDevices"
          :key="d.device_id"
          class="device-row"
        >
          <div class="device-info">
            <div class="device-name">{{ d.name }}</div>
            <div class="device-meta">{{ d.ip }}:{{ d.port }}</div>
          </div>
          <span class="status-badge badge-success">已配对</span>
          <button class="ghost-btn danger" @click="handleUnpair(d)">
            取消配对
          </button>
        </div>
      </div>
    </section>

    <!-- 在线设备卡 -->
    <section class="clean-card online-card">
      <div class="card-title">在线设备</div>
      <div v-if="onlineDevices.length === 0" class="empty-text">
        暂无在线设备
      </div>
      <div v-else class="device-list">
        <div
          v-for="d in onlineDevices"
          :key="d.device_id"
          class="device-row"
          :class="{ clickable: !d.paired }"
          @click="!d.paired && selectTarget(d)"
        >
          <div class="device-info">
            <div class="device-name">{{ d.name }}</div>
            <div class="device-meta">{{ d.ip }}:{{ d.port }}</div>
          </div>
          <span
            class="status-badge"
            :class="d.paired ? 'badge-success' : 'badge-muted'"
          >
            {{ d.paired ? "已配对" : "未配对" }}
          </span>
        </div>
      </div>
    </section>

    <!-- 数据记录卡 -->
    <section v-if="isTauri" class="clean-card records-card">
      <button
        class="records-header"
        @click="recordsCollapsed = !recordsCollapsed"
      >
        <div class="card-title">数据记录 ({{ records.length }})</div>
        <span class="chevron" :class="{ collapsed: recordsCollapsed }">▾</span>
      </button>
      <div v-if="!recordsCollapsed" class="records-body">
        <button class="pair-btn outline" @click="addTestRecord">
          + 新增测试记录
        </button>
        <div v-if="records.length === 0" class="empty-text">暂无记录</div>
        <div v-else class="records-list">
          <div v-for="r in records" :key="r.id" class="record-row">
            <div class="record-main">
              <div class="record-id">{{ truncateId(r.id, 6, 4) }}</div>
              <div class="record-content">{{ r.content }}</div>
              <div class="record-time">{{ fmtTime(r.updated_at) }}</div>
            </div>
            <button
              class="ghost-btn danger"
              @click="handleDeleteRecord(r.id)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 配对请求 modal -->
    <div
      v-if="pairRequestModal"
      class="modal-mask"
      @click.self="respondPair(false)"
    >
      <div class="clean-card modal">
        <h3 class="modal-title">配对请求</h3>
        <p class="modal-text">
          {{ pairRequestModal.from_name }} 请求配对
        </p>
        <div class="modal-actions">
          <button class="modal-btn ghost" @click="respondPair(false)">
            拒绝
          </button>
          <button class="modal-btn primary" @click="respondPair(true)">
            接受
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sync-page {
  padding: var(--space-2) var(--space-4) var(--space-12);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow-y: auto;
  height: 100%;
  background: var(--color-bg);
}

/* ===== 子标题栏 ===== */
.sub-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-immersive);
}
.back-btn:active {
  transform: scale(0.92);
}
.sub-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
  flex: 1;
}

/* ===== 卡片通用 ===== */
.card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin-bottom: var(--space-3);
}

.empty-text {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  padding: var(--space-4) 0;
  text-align: center;
}

/* ===== 本机信息卡 ===== */
.info-card .info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.info-name {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.device-id-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--bg-100);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-immersive);
}
.device-id-row:active {
  background: var(--bg-200);
}
.device-id-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.device-id-value {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.copy-hint {
  font-size: var(--text-xs);
  color: var(--color-warm);
  flex-shrink: 0;
}

/* ===== 状态徽章 ===== */
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}
.badge-success {
  background: var(--success-50);
  color: var(--success-600);
}
.badge-muted {
  background: var(--bg-200);
  color: var(--color-text-tertiary);
}

/* ===== 匹配码卡 ===== */
.pair-code-display {
  font-family: var(--font-mono);
  font-size: 40px;
  letter-spacing: 8px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  text-align: center;
  padding: var(--space-3) 0 var(--space-2);
  line-height: 1.1;
}
.countdown-track {
  width: 100%;
  height: 4px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.countdown-bar {
  height: 100%;
  background: var(--color-warm);
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}
.pair-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: var(--space-2);
  text-align: center;
}

.pair-form {
  margin-top: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.form-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}
.code-input,
.target-select {
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: var(--bg-50);
  font-size: var(--text-md);
  color: var(--color-text);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-immersive);
}
.code-input {
  font-family: var(--font-mono);
  letter-spacing: 4px;
  text-align: center;
}
.code-input:focus,
.target-select:focus {
  border-color: var(--color-warm);
}
.pair-btn {
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-immersive);
}
.pair-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pair-btn.outline {
  background: transparent;
  border: 1px dashed var(--color-warm);
  color: var(--color-warm);
}

/* ===== 设备列表 ===== */
.device-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.device-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
  transition: background var(--dur-fast) var(--ease-immersive);
}
.device-row.clickable {
  cursor: pointer;
}
.device-row.clickable:active {
  background: var(--bg-200);
}
.device-info {
  flex: 1;
  min-width: 0;
}
.device-name {
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  margin-top: 2px;
}

.ghost-btn {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  flex-shrink: 0;
}
.ghost-btn.danger {
  color: var(--danger-500);
}
.ghost-btn.danger:active {
  background: var(--danger-50);
}

/* ===== 数据记录卡 ===== */
.records-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.records-header .card-title {
  margin-bottom: 0;
}
.chevron {
  color: var(--color-text-tertiary);
  font-size: var(--text-md);
  transition: transform var(--dur-fast) var(--ease-immersive);
}
.chevron.collapsed {
  transform: rotate(-90deg);
}
.records-body {
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.records-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.record-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
}
.record-main {
  flex: 1;
  min-width: 0;
}
.record-id {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.record-content {
  font-size: var(--text-sm);
  color: var(--color-text);
  margin-top: 2px;
}
.record-time {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

/* ===== Modal ===== */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: var(--space-5);
}
.modal {
  width: 100%;
  max-width: 320px;
  padding: var(--space-5);
  text-align: center;
}
.modal-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.modal-text {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-4);
}
.modal-actions {
  display: flex;
  gap: var(--space-2);
}
.modal-btn {
  flex: 1;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.modal-btn.ghost {
  background: var(--bg-200);
  color: var(--color-text);
}
.modal-btn.primary {
  background: var(--color-warm);
  color: #fff;
}

/* ===== 平板适配 ===== */
@media (min-width: 768px) {
  .sync-page {
    max-width: 520px;
    margin: 0 auto;
    padding-left: var(--space-5);
    padding-right: var(--space-5);
  }
}
</style>
