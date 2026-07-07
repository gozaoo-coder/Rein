<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useAiChatStore } from '@/stores/aiChatStore'
import { marked } from 'marked'

const store = useAiChatStore()

const chatAreaRef = ref<HTMLElement | null>(null)
const inputText = ref('')
const isRecording = ref(false)
const recordTimer = ref(0)
let recordInterval: ReturnType<typeof setInterval> | null = null

const messages = computed(() => store.activeConversation?.messages ?? [])

const quickSuggestions = [
  '制定运动计划',
  '分析我的睡眠',
  '推荐适合我的运动',
  '如何改善体态',
]

function renderMarkdown(content: string): string {
  return marked(content, { breaks: true }) as string
}

function scrollToBottom() {
  nextTick(() => {
    if (chatAreaRef.value) {
      chatAreaRef.value.scrollTop = chatAreaRef.value.scrollHeight
    }
  })
}

function sendMessage(text?: string) {
  const content = text || inputText.value.trim()
  if (!content) return

  if (!store.activeConversation) {
    store.createConversation()
  }
  store.addMessage('user', content)
  inputText.value = ''

  // Simulated AI reply
  setTimeout(() => {
    store.addMessage('assistant', `收到你的问题："${content}"\n\n我来为你分析一下，请稍候...\n\n### 建议\n\n1. 保持每天至少30分钟的运动\n2. 注意饮食均衡\n3. 保证充足睡眠\n\n> 健康是最重要的投资。`)
    scrollToBottom()
  }, 800)

  scrollToBottom()
}

function handleSuggestionClick(text: string) {
  sendMessage(text)
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

function startRecording() {
  isRecording.value = true
  recordTimer.value = 0
  recordInterval = setInterval(() => {
    recordTimer.value++
  }, 1000)
}

function stopRecording() {
  isRecording.value = false
  if (recordInterval) {
    clearInterval(recordInterval)
    recordInterval = null
  }
  if (recordTimer.value > 0) {
    // Simulated voice input result
    sendMessage('这是语音输入的消息')
  }
  recordTimer.value = 0
}

function formatRecordTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

onMounted(() => {
  store.loadConversations()
  if (!store.activeConversation) {
    store.createConversation('AI 健康助手')
  }
  scrollToBottom()
})

watch(messages, () => {
  scrollToBottom()
}, { deep: true })
</script>

<template>
  <div class="ai-page">
    <!-- Chat Messages Area -->
    <div ref="chatAreaRef" class="chat-area scrollbar-hide">
      <!-- Welcome Banner -->
      <div v-if="messages.length === 0" class="welcome-banner glass-card">
        <div class="welcome-avatar">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </div>
        <p class="welcome-text">Hi! 我是你的AI健康助手。有什么可以帮助你的吗？</p>
        <div class="suggestion-chips">
          <button
            v-for="chip in quickSuggestions"
            :key="chip"
            class="chip"
            @click="handleSuggestionClick(chip)"
          >
            {{ chip }}
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="message-row"
        :class="msg.role"
      >
        <!-- Avatar -->
        <div class="msg-avatar" :class="msg.role">
          <svg v-if="msg.role === 'assistant'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>

        <!-- Bubble -->
        <div class="msg-bubble" :class="msg.role">
          <div
            v-if="msg.role === 'assistant'"
            class="msg-content"
            v-html="renderMarkdown(msg.content)"
          />
          <div v-else class="msg-content">
            {{ msg.content }}
          </div>
        </div>
      </div>
    </div>

    <!-- Input Bar -->
    <div class="input-bar safe-area-bottom">
      <button
        class="mic-btn"
        :class="{ recording: isRecording }"
        @mousedown="startRecording"
        @mouseup="stopRecording"
        @mouseleave="isRecording ? stopRecording() : undefined"
        @touchstart.prevent="startRecording"
        @touchend.prevent="stopRecording"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <span v-if="isRecording" class="recording-timer">{{ formatRecordTime(recordTimer) }}</span>
      </button>

      <textarea
        v-model="inputText"
        class="text-input"
        placeholder="输入消息..."
        rows="1"
        @keydown="handleKeyDown"
        @input=";(e: Event) => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 96) + 'px' }"
      />

      <button
        class="send-btn"
        :disabled="!inputText.trim()"
        @click="sendMessage()"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  position: relative;
}

/* --- Chat Area --- */
.chat-area {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) var(--space-4) 140px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* --- Welcome Banner --- */
.welcome-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-8) var(--space-5);
  gap: var(--space-4);
  text-align: center;
}

.welcome-avatar {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--brand-400), var(--brand-600));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-50);
  flex-shrink: 0;
}

.welcome-text {
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.6;
  max-width: 260px;
}

.suggestion-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
  margin-top: var(--space-2);
}

.chip {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--color-primary);
  color: var(--color-primary-text);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  transition: opacity 0.2s;
}

.chip:active {
  opacity: 0.8;
}

/* --- Message Rows --- */
.message-row {
  display: flex;
  gap: var(--space-2);
  max-width: 85%;
  align-items: flex-start;
}

.message-row.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message-row.assistant {
  align-self: flex-start;
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.msg-avatar.user {
  background: var(--brand-500);
  color: var(--text-50);
}

.msg-avatar.assistant {
  background: var(--bg-200);
  color: var(--brand-500);
}

.msg-bubble {
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
  max-width: calc(100% - 40px);
  word-break: break-word;
}

.msg-bubble.user {
  background: var(--brand-500);
  color: var(--text-50);
  border-bottom-right-radius: var(--radius-sm);
}

.msg-bubble.assistant {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: var(--glass-border);
  color: var(--color-text);
  border-bottom-left-radius: var(--radius-sm);
}

/* --- Markdown Content --- */
.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3) {
  font-weight: 600;
  margin: 8px 0 4px;
}

.msg-content :deep(p) {
  margin: 4px 0;
}

.msg-content :deep(ul),
.msg-content :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}

.msg-content :deep(code) {
  background: var(--bg-200);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
}

.msg-content :deep(pre) {
  background: var(--bg-200);
  padding: 12px;
  border-radius: var(--radius-md);
  overflow-x: auto;
}

.msg-content :deep(blockquote) {
  border-left: 3px solid var(--brand-500);
  padding-left: 12px;
  color: var(--text-600);
  margin: 8px 0;
}

.msg-content :deep(strong) {
  font-weight: 600;
}

/* --- Input Bar --- */
.input-bar {
  position: fixed;
  bottom: 64px;
  left: 0;
  right: 0;
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border-top: var(--glass-border);
  z-index: 100;
}

.mic-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s;
  position: relative;
}

.mic-btn.recording {
  background: var(--danger-500);
  color: var(--text-50);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.4); }
  50% { box-shadow: 0 0 0 10px rgba(255, 59, 48, 0); }
}

.recording-timer {
  position: absolute;
  bottom: -20px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--danger-500);
  font-weight: 600;
  white-space: nowrap;
}

.text-input {
  flex: 1;
  resize: none;
  border: none;
  background: var(--bg-200);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
  font-size: 15px;
  line-height: 1.4;
  color: var(--color-text);
  min-height: 40px;
  max-height: 96px;
  outline: none;
}

.text-input::placeholder {
  color: var(--text-400);
}

.send-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--brand-500);
  color: var(--text-50);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.2s;
}

.send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.send-btn:not(:disabled):active {
  opacity: 0.8;
}
</style>
