<script setup lang="ts">
defineProps<{
  emoji: string;
  color: string;
  size?: "sm" | "md";
}>();
</script>

<template>
  <div class="avatar" :class="size" :style="{ background: color }">{{ emoji }}</div>
</template>
