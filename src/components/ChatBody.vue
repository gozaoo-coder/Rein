<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatMessage, Session } from "../types";
import { formatMessageTime, parseSends } from "../utils";
import Avatar from "./Avatar.vue";

const props = defineProps<{
  session: Session | null;
  messages: ChatMessage[];
  streamingId: string | null;
  streamingText: string;
  sending: boolean;
  showTimeAt: (i: number) => boolean;
  renderContent: (text: string) => string;
}>();

const rootEl = ref<HTMLElement | null>(null);
defineExpose({ rootEl });

function bubblesOf(m: ChatMessage): string[] {
  if (m.role === "user") return [m.content];
  const bs = parseSends(m.content);
  return bs.length > 0 ? bs : [m.content];
}

const streamBubbles = computed(() => {
  const bs = parseSends(props.streamingText);
  return bs.length > 0 ? bs : [props.streamingText];
});
</script>

<template>
  <div ref="rootEl" class="chat-body">
    <template v-for="(m, i) in messages" :key="m.id">
      <div v-if="showTimeAt(i)" class="chat-date">{{ formatMessageTime(m.ts) }}</div>

      <!-- 对方连发气泡 -->
      <div v-if="m.role === 'assistant'" class="msg them">
        <Avatar :emoji="session?.agent_emoji ?? '🤖'" :color="session?.agent_color ?? '#576B95'" size="sm" />
        <div class="msg-body">
          <div
            v-for="(b, j) in bubblesOf(m)"
            :key="j"
            class="bubble them"
            :class="{ last: j === bubblesOf(m).length - 1 }"
            v-html="renderContent(b)"
          />
        </div>
      </div>

      <!-- 我的消息 -->
      <div v-else class="msg me">
        <div class="msg-body">
          <div class="bubble me last" v-html="renderContent(m.content)" />
        </div>
      </div>
    </template>

    <!-- 流式回复（实时拆气泡） -->
    <div v-if="streamingId" class="msg them">
      <Avatar :emoji="session?.agent_emoji ?? '🤖'" :color="session?.agent_color ?? '#576B95'" size="sm" />
      <div class="msg-body">
        <div
          v-for="(b, j) in streamBubbles"
          :key="j"
          class="bubble them"
          :class="{ last: j === streamBubbles.length - 1 }"
          v-html="
            renderContent(b) +
            (j === streamBubbles.length - 1
              ? '<span class=&quot;cursor-blink&quot;>▌</span>'
              : '')
          "
        />
      </div>
    </div>

    <!-- 等待回复 -->
    <div v-else-if="sending" class="msg them">
      <Avatar :emoji="session?.agent_emoji ?? '🤖'" :color="session?.agent_color ?? '#576B95'" size="sm" />
      <div class="msg-body">
        <div class="bubble them typing"><i /><i /><i /></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: #ededed;
  padding: 12px 12px 10px;
}
.chat-date {
  text-align: center;
  margin: 6px 0 14px;
  font-size: 11px;
  color: #a8a8a8;
}
.msg {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 16px;
  animation: msg-in 0.18s ease-out;
}
@keyframes msg-in {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.msg.them {
  align-items: flex-end;
}
.msg.them .avatar.sm {
  margin: 0 0 auto 0;
}
.msg.me {
  flex-direction: row-reverse;
}
.msg-body {
  max-width: 62%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 4px 0;
}
.msg.me .msg-body {
  align-items: flex-end;
}
/* 连发样式：中间气泡无尾巴、间距小，最后一条带尾巴 */
.bubble {
  position: relative;
  padding: 10px 12px;
  font-size: 15px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}
.bubble + .bubble {
  margin-top: 3px;
}
.msg.them .bubble {
  background: #fff;
  border-radius: 4px 4px 4px 2px;
  border: 1px solid rgba(0, 0, 0, 0.04);
}
.msg.me .bubble {
  background: #95ec69;
  border-radius: 4px 4px 2px 4px;
}
.bubble.them:not(.last) {
  border-radius: 4px;
}
.bubble.them.last::before {
  content: "";
  position: absolute;
  left: -6px;
  top: 9px;
  border: 5px solid transparent;
  border-right-color: #fff;
  border-left: 0;
}
.bubble.me.last::before {
  content: "";
  position: absolute;
  right: -6px;
  top: 9px;
  border: 5px solid transparent;
  border-left-color: #95ec69;
  border-right: 0;
}

.bubble pre {
  background: #f6f8fa;
  border-radius: 6px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 13px;
  font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  margin: 6px 0;
  user-select: text;
  white-space: pre;
}
.bubble code {
  font-family: "Cascadia Code", Consolas, monospace;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}
.bubble pre code {
  background: none;
  padding: 0;
}

.cursor-blink {
  display: inline-block;
  animation: blink 0.9s steps(1) infinite;
  color: #07c160;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}

.typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 14px 14px;
}
.typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9a9a9a;
  animation: typing-bounce 1.2s infinite;
}
.typing i:nth-child(2) {
  animation-delay: 0.15s;
}
.typing i:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes typing-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-5px);
    opacity: 1;
  }
}
</style>
