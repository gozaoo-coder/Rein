<script setup lang="ts">
/**
 * BodyMetricsPage — BMI 与体脂
 *
 * - 当前 BMI 卡片（数值 + 分类徽章 + 4 段进度条 + 三角标记）
 * - 最新体征：身高 / 体重 / 体脂 / 记录时间
 * - 记录表单（默认填入最新值）
 * - 历史记录（最近 10 条）
 */
import { computed, onMounted, reactive } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import {
  BMI_CATEGORY_LABEL,
  BMI_CATEGORY_RANGE,
  calcBmi,
  classifyBmi,
} from "@/types/health";
import type { BmiCategory } from "@/types/health";

const store = useHealthDataStore();

onMounted(() => {
  void store.load();
});

const latest = computed(() => store.latestBodyMetrics);
const currentBmi = computed(() => store.currentBmi);

const bmiCategory = computed<BmiCategory | null>(() => {
  if (currentBmi.value == null) return null;
  return classifyBmi(currentBmi.value);
});

const categoryColor = computed<string>(() => {
  const c = bmiCategory.value;
  if (c === "underweight") return "var(--warning-500)";
  if (c === "normal") return "var(--success-500)";
  if (c === "overweight") return "var(--warning-500)";
  if (c === "obese") return "var(--danger-500)";
  return "var(--bg-300)";
});

// ===== BMI 进度条（可视窗口 15..35） =====
const BMI_MIN = 15;
const BMI_MAX = 35;

function pct(bmi: number): number {
  return Math.max(0, Math.min(1, (bmi - BMI_MIN) / (BMI_MAX - BMI_MIN)));
}

const segments = computed(() => {
  const cats: BmiCategory[] = ["underweight", "normal", "overweight", "obese"];
  return cats.map((c) => {
    const range = BMI_CATEGORY_RANGE[c];
    const start = Math.max(range.min, BMI_MIN);
    const end = Math.min(range.max, BMI_MAX);
    const left = pct(start);
    const right = pct(end);
    return {
      category: c,
      label: BMI_CATEGORY_LABEL[c],
      left: left * 100,
      width: (right - left) * 100,
      color:
        c === "underweight" ? "var(--warning-500)"
        : c === "normal" ? "var(--success-500)"
        : c === "overweight" ? "var(--warning-500)"
        : "var(--danger-500)",
    };
  });
});

const markerLeft = computed(() => {
  if (currentBmi.value == null) return null;
  return pct(currentBmi.value) * 100;
});

// ===== 时间格式化 =====
function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 表单 =====
const form = reactive({
  heightCm: null as number | null,
  weightKg: null as number | null,
  bodyFatPercent: null as number | null,
});

function initFormFromLatest() {
  const l = latest.value;
  form.heightCm = l?.heightCm ?? null;
  form.weightKg = l?.weightKg ?? null;
  form.bodyFatPercent = l?.bodyFatPercent ?? null;
}

// 首次有数据时填入默认值
function ensureFormInit() {
  if (form.heightCm == null && form.weightKg == null && latest.value) {
    initFormFromLatest();
  }
}

function submit() {
  if (form.heightCm == null && form.weightKg == null) return;
  store.addBodyMetrics({
    heightCm: form.heightCm ?? undefined,
    weightKg: form.weightKg ?? undefined,
    bodyFatPercent: form.bodyFatPercent ?? undefined,
  });
}

// 历史（最近 10 条，新→旧）
const history = computed(() => store.bodyMetrics.slice().reverse().slice(0, 10));
</script>

<template>
  <div class="bm-page">
    <h2 class="page-title">BMI 与体脂</h2>

    <!-- 当前 BMI 卡片 -->
    <div class="bmi-card clean-card">
      <div class="bmi-top">
        <div class="bmi-num-block">
          <span class="bmi-num">{{ currentBmi ?? "—" }}</span>
          <span class="bmi-unit">BMI</span>
        </div>
        <span
          v-if="bmiCategory"
          class="bmi-badge"
          :style="{ background: categoryColor }"
        >{{ BMI_CATEGORY_LABEL[bmiCategory] }}</span>
      </div>

      <!-- 进度条 -->
      <div class="bmi-bar-wrap">
        <div v-if="markerLeft != null" class="bmi-marker" :style="{ left: markerLeft + '%' }">▼</div>
        <div class="bmi-bar">
          <div
            v-for="seg in segments"
            :key="seg.category"
            class="bmi-seg"
            :style="{ left: seg.left + '%', width: seg.width + '%', background: seg.color }"
          />
        </div>
        <div class="bmi-labels">
          <span
            v-for="seg in segments"
            :key="seg.category"
            class="bmi-label"
            :style="{ left: seg.left + '%', width: seg.width + '%', color: seg.color }"
          >{{ seg.label }}</span>
        </div>
      </div>
    </div>

    <!-- 最新体征 -->
    <div class="latest-card clean-card">
      <h3 class="block-title">最新体征</h3>
      <div v-if="latest" class="latest-grid">
        <div class="latest-item">
          <span class="latest-label">身高</span>
          <span class="latest-value">{{ latest.heightCm ?? "—" }}<small>cm</small></span>
        </div>
        <div class="latest-item">
          <span class="latest-label">体重</span>
          <span class="latest-value">{{ latest.weightKg ?? "—" }}<small>kg</small></span>
        </div>
        <div class="latest-item">
          <span class="latest-label">体脂率</span>
          <span class="latest-value">{{ latest.bodyFatPercent ?? "—" }}<small>%</small></span>
        </div>
        <div class="latest-item">
          <span class="latest-label">BMI</span>
          <span class="latest-value">{{ latest.bmi ?? "—" }}</span>
        </div>
      </div>
      <div v-if="latest" class="latest-time">记录于 {{ fmtDate(latest.timestamp) }}</div>
      <div v-else class="empty-inline">暂无记录</div>
    </div>

    <!-- 记录表单 -->
    <div class="form-card clean-card">
      <h3 class="block-title">记录体征</h3>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">身高 (cm)</span>
          <input
            v-model.number="form.heightCm"
            type="number"
            min="0"
            step="0.1"
            placeholder="如 175"
            class="text-input"
            @focus="ensureFormInit"
          />
        </label>
        <label class="field">
          <span class="field-label">体重 (kg)</span>
          <input
            v-model.number="form.weightKg"
            type="number"
            min="0"
            step="0.1"
            placeholder="如 70"
            class="text-input"
            @focus="ensureFormInit"
          />
        </label>
        <label class="field">
          <span class="field-label">体脂率 (%)</span>
          <input
            v-model.number="form.bodyFatPercent"
            type="number"
            min="0"
            max="100"
            step="0.1"
            placeholder="可选"
            class="text-input"
            @focus="ensureFormInit"
          />
        </label>
      </div>
      <button
        class="submit-btn"
        :disabled="form.heightCm == null && form.weightKg == null"
        @click="submit"
      >保存记录</button>
    </div>

    <!-- 历史记录 -->
    <div class="history-card clean-card">
      <h3 class="block-title">历史记录</h3>
      <div v-if="history.length === 0" class="empty-inline">暂无历史</div>
      <div v-else class="history-list">
        <div v-for="rec in history" :key="rec.id" class="history-item">
          <div class="h-date">{{ fmtDate(rec.timestamp) }}</div>
          <div class="h-metrics">
            <span v-if="rec.heightCm != null">{{ rec.heightCm }}cm</span>
            <span v-if="rec.weightKg != null">{{ rec.weightKg }}kg</span>
            <span v-if="rec.bodyFatPercent != null">脂{{ rec.bodyFatPercent }}%</span>
            <span v-if="rec.bmi != null" class="h-bmi">BMI {{ rec.bmi }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bm-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
}

.page-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

/* BMI 卡片 */
.bmi-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.bmi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bmi-num-block {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.bmi-num {
  font-size: 48px;
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}

.bmi-unit {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

.bmi-badge {
  padding: 4px 14px;
  border-radius: var(--radius-full);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
}

/* BMI 进度条 */
.bmi-bar-wrap {
  position: relative;
  padding-top: 18px;
}

.bmi-marker {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1;
  transition: left 0.4s var(--ease-immersive);
}

.bmi-bar {
  position: relative;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}

.bmi-seg {
  position: absolute;
  top: 0;
  height: 100%;
}

.bmi-labels {
  position: relative;
  margin-top: 6px;
  height: 16px;
}

.bmi-label {
  position: absolute;
  top: 0;
  text-align: center;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}

/* 卡片通用 */
.latest-card,
.form-card,
.history-card {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.block-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

/* 最新体征 */
.latest-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.latest-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.latest-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.latest-value {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}

.latest-value small {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
  margin-left: 2px;
}

.latest-time {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.empty-inline {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  padding: var(--space-2);
}

/* 表单 */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--space-2);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
}

.text-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}

.text-input:focus {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.submit-btn {
  padding: 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.submit-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}

/* 历史 */
.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.history-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.h-date {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.h-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--fw-semibold);
}

.h-bmi {
  color: var(--color-warm);
}
</style>
