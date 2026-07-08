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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22V2" />
              <path d="M17 7l-5-5-5 5" />
              <path d="M7 22h10" />
            </svg>
          </div>
          <div class="metric-info">
            <span class="metric-label">身高</span>
            <span class="metric-value">{{ profile.height > 0 ? profile.height + ' cm' : '--' }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <div class="metric-info">
            <span class="metric-label">体重</span>
            <span class="metric-value">{{ profile.weight > 0 ? profile.weight + ' kg' : '--' }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>
          <div class="metric-info">
            <span class="metric-label">年龄</span>
            <span class="metric-value">{{ profile.age > 0 ? profile.age + ' 岁' : '--' }}</span>
          </div>
        </div>

        <div class="metric">
          <div class="metric-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
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
            <!-- Chart icon -->
            <svg v-if="item.icon === 'chart'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <!-- Stats icon -->
            <svg v-else-if="item.icon === 'stats'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <!-- Todo icon -->
            <svg v-else-if="item.icon === 'todo'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <!-- Settings icon -->
            <svg v-else-if="item.icon === 'settings'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <!-- About icon -->
            <svg v-else-if="item.icon === 'about'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <svg v-else-if="item.icon === 'sync'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 3 21 3 21 8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" />
              <line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
          </div>
          <span class="menu-title">{{ item.title }}</span>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chevron">
          <polyline points="9 18 15 12 9 6" />
        </svg>
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
