<script setup lang="ts">
import { ref } from "vue";

const model = defineModel<string>({ required: true });
defineProps<{ canSend: boolean }>();
const emit = defineEmits<{ send: [] }>();

const inputEl = ref<HTMLTextAreaElement | null>(null);

function autosize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}
</script>

<template>
  <div class="chat-inputbar">
    <button class="inputbar-icon" title="语音">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/></svg>
    </button>
    <textarea
      ref="inputEl"
      v-model="model"
      class="inputbar-field"
      rows="1"
      placeholder="输入消息…（/记住 xx、/忘记 xx、/记忆）"
      @keydown.enter.exact.prevent="emit('send')"
      @input="autosize"
    />
    <button v-if="canSend" class="send-btn" @click="emit('send')">发送</button>
    <button v-else class="inputbar-icon" title="更多">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </button>
  </div>
</template>

<style scoped>
.chat-inputbar {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 7px 10px;
  background: #f7f7f7;
  border-top: 1px solid #c8c8c8;
  z-index: 20;
}
.inputbar-icon {
  flex: none;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #5a5a5a;
  border-radius: 6px;
}
.inputbar-icon:hover {
  background: rgba(0, 0, 0, 0.05);
}
.inputbar-field {
  flex: 1;
  min-height: 36px;
  max-height: 120px;
  background: #fff;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 15px;
  line-height: 1.4;
  resize: none;
  overflow-y: auto;
  user-select: text;
}
.send-btn {
  flex: none;
  height: 33px;
  padding: 0 15px;
  border-radius: 4px;
  background: #07c160;
  color: #fff;
  font-size: 15px;
  transition: all 0.15s;
}
.send-btn:hover {
  background: #06ad56;
}
.send-btn:active {
  transform: scale(0.96);
}
.send-btn:disabled {
  background: #c9c9c9;
  cursor: not-allowed;
}
</style>
