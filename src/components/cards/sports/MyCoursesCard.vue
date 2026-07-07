<script setup lang="ts">
withDefaults(defineProps<{
  courses?: { name: string; duration: string }[]
}>(), {
  courses: () => [],
})
</script>

<template>
  <div class="my-courses-card">
    <div class="card-header">
      <span class="card-label">我的课程</span>
      <span class="card-count">{{ courses.length }} 个课程</span>
    </div>
    <div class="course-list">
      <div v-for="(course, idx) in courses" :key="idx" class="course-item">
        <div class="course-index">{{ idx + 1 }}</div>
        <div class="course-info">
          <span class="course-name">{{ course.name }}</span>
          <span class="course-duration">{{ course.duration }}</span>
        </div>
      </div>
      <div v-if="courses.length === 0" class="empty-hint">暂无课程</div>
    </div>
  </div>
</template>

<style scoped>
.my-courses-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  height: 100%;
  box-sizing: border-box;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.card-count {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.course-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  overflow-y: auto;
}

.course-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
}

.course-index {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  background: var(--brand-500);
  color: white;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.course-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 1;
  min-width: 0;
}

.course-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.course-duration {
  font-size: 12px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  margin-left: var(--space-2);
}

.empty-hint {
  font-size: 13px;
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}
</style>
