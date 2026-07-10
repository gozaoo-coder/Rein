<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/userStore'
import BottomSheet from '@/components/ui/BottomSheet.vue'

const router = useRouter()
const userStore = useUserStore()
const profile = userStore.profile
const bmi = userStore.bmi

onMounted(() => {
  void userStore.load()
})

const nickname = computed(() => profile.nickname || '未设置')

const bmiColor = computed(() => {
  if (bmi <= 0) return 'var(--text-400)'
  if (bmi < 18.5) return 'var(--brand-500)'
  if (bmi < 24) return 'var(--success-500)'
  if (bmi < 28) return 'var(--warning-500)'
  return 'var(--danger-500)'
})

const bmiLabel = computed(() => {
  if (bmi <= 0) return '--'
  if (bmi < 18.5) return '偏瘦'
  if (bmi < 24) return '正常'
  if (bmi < 28) return '偏胖'
  return '肥胖'
})

const genderLabel = computed(() => {
  const map: Record<string, string> = { male: '男', female: '女', other: '未设置' }
  return map[profile.gender] || '未设置'
})

const birthdayLabel = computed(() => profile.birthday || '未设置')
const ageLabel = computed(() => userStore.computedAge > 0 ? userStore.computedAge + ' 岁' : '--')

const initialLetter = computed(() => {
  const name = profile.nickname || profile.avatar || ''
  return name.charAt(0).toUpperCase() || '?'
})

const menuItems = [
  {
    icon: 'chart',
    title: '所有运动数据',
    path: '/sports',
  },
  {
    icon: 'history',
    title: '运动记录',
    path: '/workout/history',
  },
  {
    icon: 'todo',
    title: '待办事项',
    path: '/todo',
  },
  {
    icon: 'sync',
    title: 'P2P 多设备同步',
    path: '/sync',
  },
  {
    icon: 'stats',
    title: '统计数据',
    path: '',
  },
  {
    icon: 'settings',
    title: '设置',
    path: '',
  },
  {
    icon: 'about',
    title: '关于 Rein',
    path: '',
  },
]

function handleMenuClick(path: string) {
  if (!path) return
  router.push(path)
}

// ============ 编辑 BottomSheet ============
const showEditSheet = ref(false)

interface EditForm {
  nickname: string
  gender: 'male' | 'female' | 'other'
  birthday: string
  height: number
  weight: number
  targetWeight: number
}

const form = reactive<EditForm>({
  nickname: '',
  gender: 'other',
  birthday: '',
  height: 0,
  weight: 0,
  targetWeight: 0,
})

const genderOptions: { value: 'male' | 'female' | 'other'; label: string; icon: string }[] = [
  { value: 'male', label: '男', icon: 'bi-gender-male' },
  { value: 'female', label: '女', icon: 'bi-gender-female' },
  { value: 'other', label: '其他', icon: 'bi-gender-ambiguous' },
]

function openEditSheet() {
  form.nickname = profile.nickname
  form.gender = profile.gender
  form.birthday = profile.birthday
  form.height = profile.height
  form.weight = profile.weight
  form.targetWeight = profile.targetWeight
  showEditSheet.value = true
}

function closeEditSheet() {
  showEditSheet.value = false
}

function saveForm() {
  userStore.setProfile({
    nickname: form.nickname.trim(),
    gender: form.gender,
    birthday: form.birthday,
    height: Number(form.height) || 0,
    weight: Number(form.weight) || 0,
    targetWeight: Number(form.targetWeight) || 0,
  })
  closeEditSheet()
}
</script>

<template>
  <div class="profile-page">
    <!-- Body Overview Section -->
    <div class="profile-header">
      <div class="avatar-circle">
        {{ initialLetter }}
      </div>
      <h2 class="nickname">{{ nickname }}</h2>
      <div class="bmi-badge" :style="{ color: bmiColor, borderColor: bmiColor }">
        <span class="bmi-value">BMI {{ bmi > 0 ? bmi : '--' }}</span>
        <span class="bmi-label">{{ bmiLabel }}</span>
      </div>
    </div>

    <!-- Body Data Card -->
    <div class="glass-card body-card">
      <div class="body-card-head">
        <span class="body-card-title">身体数据</span>
        <button class="edit-btn" @click="openEditSheet">
          <i class="bi bi-pencil-square" style="font-size:14px"></i>
          去编辑
        </button>
      </div>
      <div class="body-grid">
        <div class="metric">
          <div class="metric-icon">
            <i class="bi bi-rulers" style="font-size:18px"></i>
          </div>
          <div class="metric-info">
            <span class="metric-label">身高</span>
            <span class="metric-value">{{ profile.height > 0 ? profile.height + ' cm' : '--' }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <i class="bi bi-brightness-high" style="font-size:18px"></i>
          </div>
          <div class="metric-info">
            <span class="metric-label">体重</span>
            <span class="metric-value">{{ profile.weight > 0 ? profile.weight + ' kg' : '--' }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <i class="bi bi-calendar3" style="font-size:18px"></i>
          </div>
          <div class="metric-info">
            <span class="metric-label">生日</span>
            <span class="metric-value">{{ birthdayLabel }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <i class="bi bi-person" style="font-size:18px"></i>
          </div>
          <div class="metric-info">
            <span class="metric-label">年龄 / 性别</span>
            <span class="metric-value">{{ ageLabel }} · {{ genderLabel }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Menu List -->
    <div class="glass-card menu-card">
      <button
        v-for="item in menuItems"
        :key="item.title"
        class="menu-item"
        @click="handleMenuClick(item.path)"
      >
        <div class="menu-item-left">
          <div class="menu-icon" :class="item.icon">
            <i v-if="item.icon === 'chart'" class="bi bi-bar-chart" style="font-size:20px"></i>
            <i v-else-if="item.icon === 'history'" class="bi bi-clock-history" style="font-size:20px"></i>
            <i v-else-if="item.icon === 'stats'" class="bi bi-activity" style="font-size:20px"></i>
            <i v-else-if="item.icon === 'todo'" class="bi bi-check2-square" style="font-size:20px"></i>
            <i v-else-if="item.icon === 'settings'" class="bi bi-gear-fill" style="font-size:20px"></i>
            <i v-else-if="item.icon === 'about'" class="bi bi-info-circle" style="font-size:20px"></i>
            <i v-else-if="item.icon === 'sync'" class="bi bi-arrow-repeat" style="font-size:20px"></i>
          </div>
          <span class="menu-title">{{ item.title }}</span>
        </div>
        <i class="bi bi-chevron-right chevron" style="font-size:16px"></i>
      </button>
    </div>

    <!-- ============ 编辑信息 BottomSheet ============ -->
    <BottomSheet
      :visible="showEditSheet"
      title="编辑个人信息"
      :detents="['large']"
      default-detent="large"
      @update:visible="(v) => { if (!v) closeEditSheet() }"
      @close="closeEditSheet"
    >
      <div class="ed-scroll">
        <!-- 昵称 -->
        <div class="ed-section">
          <div class="ed-section-title">昵称</div>
          <input
            v-model="form.nickname"
            class="ed-input"
            type="text"
            placeholder="设置昵称"
            maxlength="20"
          />
        </div>

        <!-- 性别 -->
        <div class="ed-section">
          <div class="ed-section-title">性别</div>
          <div class="gender-cards">
            <button
              v-for="g in genderOptions"
              :key="g.value"
              class="gender-card"
              :class="{ active: form.gender === g.value }"
              @click="form.gender = g.value"
            >
              <i class="bi" :class="g.icon" style="font-size:20px"></i>
              <span>{{ g.label }}</span>
            </button>
          </div>
        </div>

        <!-- 生日 -->
        <div class="ed-section">
          <div class="ed-section-title">生日</div>
          <input
            v-model="form.birthday"
            class="ed-input"
            type="date"
          />
        </div>

        <!-- 身高 / 体重 -->
        <div class="ed-section ed-section-row">
          <div class="ed-cell">
            <div class="ed-section-title">身高 (cm)</div>
            <input
              v-model.number="form.height"
              class="ed-input"
              type="number"
              min="0"
              max="300"
              step="0.1"
              inputmode="decimal"
            />
          </div>
          <div class="ed-cell">
            <div class="ed-section-title">体重 (kg)</div>
            <input
              v-model.number="form.weight"
              class="ed-input"
              type="number"
              min="0"
              max="500"
              step="0.1"
              inputmode="decimal"
            />
          </div>
        </div>

        <!-- 目标体重 -->
        <div class="ed-section">
          <div class="ed-section-title">目标体重 (kg)</div>
          <input
            v-model.number="form.targetWeight"
            class="ed-input"
            type="number"
            min="0"
            max="500"
            step="0.1"
            inputmode="decimal"
          />
        </div>

        <div class="ed-bottom-space" />
      </div>

      <!-- 固定保存栏 -->
      <div class="ed-footer">
        <button class="ed-footer-save" @click="saveForm">
          保存
        </button>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.profile-page {
  padding: var(--space-6) var(--space-4) var(--space-20);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  overflow-y: auto;
  height: 100%;
  background: var(--color-bg);
}

/* --- Profile Header --- */
.profile-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-4);
}

.avatar-circle {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--brand-400), var(--brand-600));
  color: var(--text-50);
  font-size: 24px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.nickname {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text);
}

.bmi-badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1.5px solid;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 600;
}

.bmi-value {
  font-size: 14px;
}

.bmi-label {
  opacity: 0.8;
  font-size: 12px;
  font-weight: 500;
}

/* --- Body Data Card --- */
.body-card {
  padding: var(--space-5);
}

.body-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.body-card-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  color: var(--brand-500);
  font-size: 12px;
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: background 0.15s, transform 0.15s;
}
.edit-btn:active {
  transform: scale(0.94);
  background: var(--bg-300);
}

.body-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-5);
}

.metric {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.metric-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--bg-200);
  color: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.metric-info {
  display: flex;
  flex-direction: column;
}

.metric-label {
  font-size: 12px;
  color: var(--text-500);
}

.metric-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

/* --- Menu Card --- */
.menu-card {
  overflow: hidden;
  padding: 0;
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  color: var(--color-text);
  border-bottom: 1px solid var(--bg-300);
  width: 100%;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:last-child {
  border-bottom: none;
}

.menu-item:active {
  background: var(--bg-200);
}

.menu-item-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.menu-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.menu-icon.chart {
  background: rgba(0, 122, 255, 0.12);
  color: var(--brand-500);
}

.menu-icon.history {
  background: rgba(61, 169, 255, 0.12);
  color: var(--icon-blue);
}

.menu-icon.stats {
  background: rgba(52, 199, 89, 0.12);
  color: var(--success-500);
}

.menu-icon.todo {
  background: rgba(255, 102, 51, 0.12);
  color: var(--warm-500);
}

.menu-icon.settings {
  background: rgba(142, 142, 147, 0.12);
  color: var(--text-600);
}

.menu-icon.about {
  background: rgba(0, 122, 255, 0.12);
  color: var(--brand-500);
}

.menu-icon.sync {
  background: rgba(48, 209, 88, 0.12);
  color: var(--success-500);
}

.menu-title {
  font-size: 15px;
  font-weight: 500;
}

.chevron {
  color: var(--text-400);
  flex-shrink: 0;
}

/* ====== 编辑 BottomSheet 内部 ====== */
.ed-scroll {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.ed-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ed-section-row {
  flex-direction: row;
  gap: var(--space-3);
}

.ed-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.ed-section-title {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text-secondary);
  padding: 0 var(--space-1);
}

.ed-input {
  width: 100%;
  border: 1px solid var(--bg-300);
  background: var(--bg-50);
  color: var(--color-text);
  font-size: var(--text-md);
  padding: var(--space-3) var(--space-3);
  border-radius: var(--radius-md);
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-family: inherit;
}
.ed-input:focus {
  border-color: var(--brand-500);
  box-shadow: 0 0 0 3px var(--brand-50, rgba(0, 122, 255, 0.1));
}

.gender-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}

.gender-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--space-3) var(--space-2);
  border: 1.5px solid var(--bg-300);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  transition: all 0.15s;
}
.gender-card.active {
  border-color: var(--brand-500);
  background: rgba(0, 122, 255, 0.08);
  color: var(--brand-500);
}
.gender-card:active {
  transform: scale(0.96);
}

.ed-bottom-space {
  height: var(--space-4);
}

.ed-footer {
  position: sticky;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-50);
  border-top: 1px solid var(--color-divider);
  margin: 0 calc(-1 * var(--space-4)) 0;
}

.ed-footer-save {
  flex: 1;
  border: none;
  background: var(--brand-500);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  padding: var(--space-3);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: transform 0.15s, opacity 0.15s;
}
.ed-footer-save:active {
  transform: scale(0.97);
  opacity: 0.9;
}
</style>
