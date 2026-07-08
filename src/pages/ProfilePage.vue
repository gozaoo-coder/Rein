<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/userStore'

const router = useRouter()
const userStore = useUserStore()
const profile = userStore.profile
const bmi = userStore.bmi

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
            <span class="metric-label">年龄</span>
            <span class="metric-value">{{ profile.age > 0 ? profile.age + ' 岁' : '--' }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <i class="bi bi-person" style="font-size:18px"></i>
          </div>
          <div class="metric-info">
            <span class="metric-label">性别</span>
            <span class="metric-value">{{ genderLabel }}</span>
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
</style>
