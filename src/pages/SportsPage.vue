<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useHrBroadcast } from "@/composables/useHrBroadcast";
import { useCourseStore } from "@/stores/courseStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useWorkoutStore } from "@/stores/workoutStore";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  type Course,
} from "@/types/course";

const router = useRouter();
const courseStore = useCourseStore();
const statsStore = useWorkoutStatsStore();
const workoutStore = useWorkoutStore();

const {
  state: hrState,
  devices: hrDevices,
  connectedDevice: hrConnected,
  heartRate: hrValue,
  isConnected: hrConnectedFlag,
  scan: hrScan,
  cancelScan: hrCancelScan,
  connect: hrConnect,
  disconnect: hrDisconnect,
} = useHrBroadcast();

const pinned = computed(() => courseStore.pinnedCourses);
const recent = computed(() => courseStore.recentCourses);
const byDifficulty = computed(() => courseStore.coursesByDifficulty);

const totalMinutes = computed(() =>
  Math.round(statsStore.totalDurationSec / 60),
);

/** 最近 5 条训练记录（按时间倒序） */
const recentRecords = computed(() =>
  [...statsStore.records]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5),
);

function startCourse(course: Course) {
  workoutStore.startCourse(course);
  router.push("/workout");
}

function openCourse(course: Course) {
  router.push(`/sports/courses/${course.id}`);
}

function openRecord(id: string) {
  router.push(`/workout/history/${id}`);
}

function openAllCourses(difficulty?: string) {
  if (difficulty) {
    router.push({ path: "/sports/courses", query: { difficulty } });
  } else {
    router.push("/sports/courses");
  }
}

function openExercises() {
  router.push("/sports/exercises");
}

function fmtMinutes(min: number): string {
  if (min < 60) return `${min}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m}`;
}

function fmtRecordDate(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function fmtRecordDuration(sec: number): string {
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

onMounted(() => {
  courseStore.load();
  statsStore.load();
});
</script>

<template>
  <div class="sports-page">
    <!-- HR 广播绑定卡片 -->
    <section class="clean-card hr-card">
      <div class="hr-left">
        <div class="hr-icon" :class="{ connected: hrConnectedFlag }">
          <i class="bi bi-heart-pulse" style="font-size:22px"></i>
        </div>
        <div class="hr-text">
          <div class="hr-title">
            <template v-if="hrConnectedFlag">{{ hrConnected?.name }}</template>
            <template v-else-if="hrState === 'scanning'">正在搜索设备…</template>
            <template v-else>蓝牙心率广播</template>
          </div>
          <div class="hr-sub">
            <template v-if="hrConnectedFlag">实时心率 · 已绑定</template>
            <template v-else>绑定胸带/手表广播心率</template>
          </div>
        </div>
      </div>

      <div class="hr-right">
        <template v-if="hrConnectedFlag">
          <div class="hr-value">
            <span class="hr-num">{{ hrValue ?? "--" }}</span>
            <span class="hr-unit">bpm</span>
          </div>
          <button class="hr-btn ghost" @click="hrDisconnect">断开</button>
        </template>
        <template v-else-if="hrState === 'scanning'">
          <button class="hr-btn ghost" @click="hrCancelScan">取消</button>
        </template>
        <template v-else>
          <button class="hr-btn primary" @click="hrScan">扫描设备</button>
        </template>
      </div>

      <!-- 扫描结果列表 -->
      <div v-if="hrState !== 'connected' && hrDevices.length" class="hr-device-list">
        <button
          v-for="d in hrDevices"
          :key="d.id"
          class="hr-device"
          @click="hrConnect(d)"
        >
          <div class="hr-device-name">{{ d.name }}</div>
          <div class="hr-device-rssi">信号 {{ d.rssi }}dBm</div>
        </button>
      </div>
    </section>

    <!-- 统计快览 -->
    <section class="clean-card stats-card" v-if="statsStore.totalSessions > 0">
      <div class="stat-block">
        <div class="stat-num">{{ statsStore.totalSessions }}</div>
        <div class="stat-label">总训练</div>
      </div>
      <div class="stat-divider" />
      <div class="stat-block">
        <div class="stat-num">{{ fmtMinutes(totalMinutes) }}</div>
        <div class="stat-label">分钟</div>
      </div>
      <div class="stat-divider" />
      <div class="stat-block">
        <div class="stat-num">{{ statsStore.streakDays }}</div>
        <div class="stat-label">连续天</div>
      </div>
      <div class="stat-divider" />
      <div class="stat-block">
        <div class="stat-num">{{ Math.round(statsStore.totalCalories) }}</div>
        <div class="stat-label">千卡</div>
      </div>
    </section>

    <!-- 最近训练记录 -->
    <section v-if="recentRecords.length" class="block">
      <div class="block-head">
        <h3 class="block-title">最近训练记录</h3>
        <span class="block-count">{{ statsStore.records.length }}</span>
      </div>
      <div class="rec-list">
        <button
          v-for="r in recentRecords"
          :key="r.id"
          class="rec-row clean-card clean-card--interactive"
          @click="openRecord(r.id)"
        >
          <div class="rec-main">
            <div class="rec-name">{{ r.courseName }}</div>
            <div class="rec-meta">
              <span>{{ fmtRecordDate(r.startedAt) }}</span>
              <span class="dot">·</span>
              <span>{{ fmtRecordDuration(r.durationSec) }}</span>
              <span class="dot">·</span>
              <span>{{ Math.round(r.caloriesBurned) }}kcal</span>
              <span class="dot">·</span>
              <span :class="r.finished ? 'rec-done' : 'rec-partial'">
                {{ r.finished ? '完成' : '中断' }}
              </span>
            </div>
          </div>
          <i class="bi bi-chevron-right chevron" style="font-size:18px"></i>
        </button>
      </div>
    </section>

    <!-- 置顶课程 -->
    <section v-if="pinned.length" class="block">
      <div class="block-head">
        <h3 class="block-title">置顶</h3>
        <span class="block-count">{{ pinned.length }}</span>
      </div>
      <div class="hscroll">
        <button
          v-for="c in pinned"
          :key="c.id"
          class="course-card clean-card clean-card--interactive pinned"
          @click="openCourse(c)"
        >
          <div class="course-pin">
            <i class="bi bi-pin-angle-fill" style="font-size:14px"></i>
          </div>
          <div class="course-card-body">
            <div class="course-name">{{ c.name }}</div>
            <div class="course-meta">
              <span>{{ CATEGORY_LABEL[c.category] }}</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedMinutes }}min</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedCalories }}kcal</span>
            </div>
            <div class="course-actions">
              <button class="mini-btn primary" @click.stop="startCourse(c)">开始</button>
              <span class="course-diff">{{ DIFFICULTY_LABEL[c.difficulty] }}</span>
            </div>
          </div>
        </button>
      </div>
    </section>

    <!-- 最近在练 -->
    <section v-if="recent.length" class="block">
      <div class="block-head">
        <h3 class="block-title">最近在练</h3>
        <span class="block-count">{{ recent.length }}</span>
      </div>
      <div class="hscroll">
        <button
          v-for="c in recent"
          :key="c.id"
          class="course-card clean-card clean-card--interactive"
          @click="openCourse(c)"
        >
          <div class="course-card-body">
            <div class="course-name">{{ c.name }}</div>
            <div class="course-meta">
              <span>{{ CATEGORY_LABEL[c.category] }}</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedMinutes }}min</span>
            </div>
            <div class="course-actions">
              <button class="mini-btn primary" @click.stop="startCourse(c)">开始</button>
              <span class="course-diff">{{ DIFFICULTY_LABEL[c.difficulty] }}</span>
            </div>
          </div>
        </button>
      </div>
    </section>

    <!-- 按难度分组 -->
    <section
      v-for="grp in byDifficulty"
      :key="grp.key"
      class="block"
    >
      <div class="block-head">
        <h3 class="block-title">{{ grp.label }}</h3>
        <button class="see-all" @click="openAllCourses(grp.key)">查看全部 ›</button>
      </div>
      <div v-if="grp.courses.length" class="course-list">
        <button
          v-for="c in grp.courses"
          :key="c.id"
          class="course-row clean-card clean-card--interactive"
          @click="openCourse(c)"
        >
          <div class="course-row-main">
            <div class="course-row-name">
              <span v-if="c.pinned" class="pin-mark">★</span>
              {{ c.name }}
            </div>
            <div class="course-row-meta">
              <span>{{ CATEGORY_LABEL[c.category] }}</span>
              <span class="dot">·</span>
              <span>{{ c.steps.length }}组</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedMinutes }}min</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedCalories }}kcal</span>
            </div>
          </div>
          <div class="course-row-right">
            <button class="mini-btn primary" @click.stop="startCourse(c)">开始</button>
            <i class="bi bi-chevron-right chevron" style="font-size:18px"></i>
          </div>
        </button>
      </div>
      <div v-else class="empty-hint">暂无{{ grp.label }}课程</div>
    </section>

    <!-- 动作库入口 -->
    <section class="block">
      <div class="block-head">
        <h3 class="block-title">动作库</h3>
      </div>
      <button class="ex-entry clean-card clean-card--interactive" @click="openExercises">
        <div class="ex-icon icon-circle icon-circle--orange">
          <i class="bi bi-dumbbell" style="font-size:20px"></i>
        </div>
        <div class="ex-text">
          <div class="ex-name">动作库</div>
          <div class="ex-sub">徒手 / 器械，支持自定义新增</div>
        </div>
        <i class="bi bi-chevron-right chevron" style="font-size:18px"></i>
      </button>
    </section>
  </div>
</template>

<style scoped>
.sports-page {
  padding: 0 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* HR 卡片 */
.hr-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
}
.hr-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}
.hr-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.hr-icon.connected {
  background: var(--color-warm);
  color: #fff;
  animation: hr-pulse 1.4s ease-in-out infinite;
}
@keyframes hr-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
.hr-text { min-width: 0; }
.hr-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hr-sub {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.hr-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.hr-value {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.hr-num {
  font-size: 28px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
}
.hr-unit {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.hr-btn {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border: none;
  cursor: pointer;
  transition: opacity var(--dur-fast);
}
.hr-btn.primary { background: var(--color-warm); color: #fff; }
.hr-btn.ghost { background: var(--bg-200); color: var(--color-text); }
.hr-btn:active { opacity: 0.7; }
.hr-device-list {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-divider);
}
.hr-device {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
}
.hr-device:active { background: var(--bg-200); }
.hr-device-name { font-size: var(--text-sm); color: var(--color-text); font-weight: var(--fw-medium); }
.hr-device-rssi { font-size: var(--text-xs); color: var(--color-text-secondary); }

/* 统计卡片 */
.stats-card {
  display: flex;
  align-items: center;
  padding: var(--space-4) var(--space-3);
}
.stat-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.stat-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}
.stat-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.stat-divider {
  width: 1px;
  height: 28px;
  background: var(--color-divider);
}

/* 区块 */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-1);
}
.block-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0;
}
.block-count {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  background: var(--bg-200);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  margin-left: var(--space-2);
}
.see-all {
  background: transparent;
  border: none;
  font-size: var(--text-sm);
  color: var(--color-warm);
  cursor: pointer;
  padding: 0;
}
.see-all:active { opacity: 0.7; }

/* 横滑 */
.hscroll {
  display: flex;
  gap: var(--space-3);
  overflow-x: auto;
  padding: 2px 0 var(--space-2);
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  margin: 0 calc(-1 * var(--space-1));
  padding-left: var(--space-1);
  padding-right: var(--space-1);
}
.hscroll::-webkit-scrollbar { display: none; }

.course-card {
  position: relative;
  width: 200px;
  flex-shrink: 0;
  padding: var(--space-4);
  border: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.course-card.pinned {
  border: 1px solid var(--warm-200);
}
.course-pin {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--color-warm);
  display: flex;
}
.course-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.course-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.course-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.course-meta .dot { color: var(--color-text-tertiary); }
.course-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-1);
}
.mini-btn {
  padding: 4px 14px;
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-medium);
  border: none;
  cursor: pointer;
}
.mini-btn.primary { background: var(--color-warm); color: #fff; }
.mini-btn:active { opacity: 0.8; }
.course-diff {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* 课程列表（纵向） */
.course-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.course-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: none;
  text-align: left;
}
.course-row-main { flex: 1; min-width: 0; }
.course-row-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.pin-mark { color: var(--color-warm); font-size: var(--text-sm); }
.course-row-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.course-row-meta .dot { color: var(--color-text-tertiary); }
.course-row-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.empty-hint {
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
}

/* 动作库入口 */
.ex-entry {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: none;
  text-align: left;
  width: 100%;
}
.ex-text { flex: 1; min-width: 0; }
.ex-name { font-size: var(--text-md); font-weight: var(--fw-semibold); color: var(--color-text); }
.ex-sub { font-size: var(--text-xs); color: var(--color-text-secondary); margin-top: 2px; }

/* 训练记录列表 */
.rec-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.rec-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: none;
  text-align: left;
}
.rec-main { flex: 1; min-width: 0; }
.rec-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.rec-meta .dot { color: var(--color-text-tertiary); }
.rec-done { color: var(--color-success); font-weight: var(--fw-medium); }
.rec-partial { color: var(--color-warning); font-weight: var(--fw-medium); }
</style>
