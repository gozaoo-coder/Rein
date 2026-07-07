<script setup lang="ts">
import { useRouter } from "vue-router";
const router = useRouter();
</script>

<template>
  <div class="devices-placeholder">
    <div class="placeholder-card clean-card">
      <h2>设备</h2>
      <p>连接智能手表、手环等设备以同步健康数据</p>
      <button class="connect-btn" @click="router.push('/')">返回健康</button>
    </div>
  </div>
</template>

<style scoped>
.devices-placeholder {
  padding: var(--space-6) 0;
}

.placeholder-card {
  text-align: center;
  padding: var(--space-10) var(--space-6);
}

.placeholder-card h2 {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  margin-bottom: var(--space-3);
}

.placeholder-card p {
  color: var(--color-text-secondary);
  font-size: var(--text-md);
  margin-bottom: var(--space-6);
}

.connect-btn {
  padding: var(--space-3) var(--space-6);
  border-radius: var(--radius-full);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  transition: opacity var(--dur-fast);
}

.connect-btn:active {
  opacity: 0.8;
}
</style>
