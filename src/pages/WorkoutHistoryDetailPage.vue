<script setup lang="ts">
/**
 * WorkoutHistoryDetailPage — 某次历史运动详情
 *
 * 路由：/workout/history/:id
 * 数据源：workoutStatsStore.getRecord(id)
 * 功能：展示完整记录信息 + 删除 + 分享
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useToast } from "@/composables/useToast";
import ShareSheet from "@/components/share/ShareSheet.vue";
import ShareButton from "@/components/share/ShareButton.vue";
import { formatWorkoutHistory } from "@/data/shareFormatters";
import type { ShareContent } from "@/types/share";
import type { WorkoutRecord } from "@/types/workout-stats";

const route = useRoute();
const router = useRouter();
const store = useWorkoutStatsStore();
const toast = useToast();

const record = ref<WorkoutRecord | undefined>(undefined);
const pendingDelete = ref(false);
const showShare = ref(false);

const shareContent = computed<ShareContent | null>(() =>
  record.value ? formatWorkoutHistory(record.value) : null,
);

const startDate = computed(() => {
  if (!record.value) return null;
  return new Date(record.value.startedAt);
});

const endDate = computed(() => {
  if (!record.value) return null;
  return new Date(record.value.endedAt);
});

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

function fmtDuration(sec: number): string {
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function goBack() {
  router.back();
}

function askDelete() {
  pendingDelete.value = true;
}
function cancelDelete() {
  pendingDelete.value = false;
}
function confirmDelete() {
  if (!record.value) return;
  store.deleteRecord(record.value.id);
  toast.success("已删除记录");
  router.back();
}

onMounted(async () => {
  await store.load();
  const id = route.params.id as string;
  record.value = store.getRecord(id);
});
</script>

<template>
  <div class="history-detail-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h2 class="sub-title">运动记录详情</h2>
      <ShareButton v-if="record" @click="showShare = true" />
    </header>

    <div v-if="record" class="content">
      <section class="clean-card hero-card">
        <div class="hero-glow" />
        <h1 class="hero-title">{{ record.courseName }}</h1>
        <div class="hero-meta">
          <span class="hero-status" :class="record.finished ? 'done' : 'partial'">
            {{ record.finished ? '已完成' : '中途退出' }}
          </span>
          <span class="hero-time">{{ startDate ? fmtDate(startDate) : '' }}</span>
        </div>
      </section>

      <section class="clean-card stats-grid">
        <div class="stat-cell">
          <div class="stat-val">{{ fmtDuration(record.durationSec) }}</div>
          <div class="stat-lbl">总时长</div>
        </div>
        <div class="stat-cell">
          <div class="stat-val">{{ Math.round(record.caloriesBurned) }}</div>
          <div class="stat-lbl">消耗 kcal</div>
        </div>
        <div class="stat-cell">
          <div class="stat-val">{{ record.completedSets }}/{{ record.totalSets }}</div>
          <div class="stat-lbl">完成组数</div>
        </div>
        <div class="stat-cell" v-if="record.avgHeartRate">
          <div class="stat-val">{{ record.avgHeartRate }}</div>
          <div class="stat-lbl">平均 BPM</div>
        </div>
        <div class="stat-cell" v-if="record.maxHeartRate">
          <div class="stat-val">{{ record.maxHeartRate }}</div>
          <div class="stat-lbl">最大 BPM</div>
        </div>
      </section>

      <section class="clean-card detail-card">
        <div class="detail-row">
          <span class="detail-lbl">课程类别</span>
          <span class="detail-val">{{ record.courseCategory }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">开始时间</span>
          <span class="detail-val">{{ startDate ? fmtDate(startDate) : '--' }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">结束时间</span>
          <span class="detail-val">{{ endDate ? fmtDate(endDate) : '--' }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">记录 ID</span>
          <span class="detail-val mono">{{ record.id }}</span>
        </div>
      </section>

      <button class="danger-btn" @click="askDelete">删除此记录</button>
    </div>

    <div v-else class="empty">
      <p>未找到该记录</p>
      <button class="ghost-btn" @click="goBack">返回</button>
    </div>

    <!-- 删除确认 -->
    <div v-if="pendingDelete" class="modal-mask" @click.self="cancelDelete">
      <div class="clean-card modal">
        <h3 class="modal-title">删除记录</h3>
        <p class="modal-text">确认删除该次运动记录？此操作不可撤销。</p>
        <div class="modal-actions">
          <button class="ghost-btn modal-btn" @click="cancelDelete">取消</button>
          <button class="danger-btn modal-btn" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 分享面板 -->
    <ShareSheet
      v-if="showShare && shareContent"
      :content="shareContent"
      @close="showShare = false"
    />
  </div>
</template>

<style scoped>
.history-detail-page {
  padding: var(--space-2) 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sub-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sub-title {
  flex: 1;
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.hero-card {
  padding: var(--space-6);
  position: relative;
  overflow: hidden;
}
.hero-glow {
  position: absolute;
  top: -40px;
  right: -40px;
  width: 200px;
  height: 200px;
  background: radial-gradient(circle, var(--glow-orange), transparent 70%);
  pointer-events: none;
}
.hero-title {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
  position: relative;
}
.hero-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  position: relative;
}
.hero-status {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  padding: 3px 10px;
  border-radius: var(--radius-full);
}
.hero-status.done {
  background: var(--success-50);
  color: var(--success-600);
}
.hero-status.partial {
  background: var(--warning-50);
  color: var(--warning-600);
}
.hero-time {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.stats-grid {
  padding: var(--space-4);
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}
.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--space-3);
  background: var(--bg-50);
  border-radius: var(--radius-md);
}
.stat-val {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--warm-500);
  font-variant-numeric: tabular-nums;
}
.stat-lbl {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.detail-card {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--text-sm);
}
.detail-lbl {
  color: var(--color-text-secondary);
}
.detail-val {
  color: var(--color-text);
  font-weight: var(--fw-medium);
}
.detail-val.mono {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.danger-btn {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: none;
  background: var(--color-danger);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.ghost-btn {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-12) 0;
  color: var(--color-text-tertiary);
}

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
}
</style>
