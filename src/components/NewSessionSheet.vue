<script setup lang="ts">
import { ref } from "vue";
import type { Agent } from "../types";
import Avatar from "./Avatar.vue";

defineProps<{ agents: Agent[] }>();
const emit = defineEmits<{ close: []; create: [payload: { title: string; agentId: string | null }] }>();

const newTitle = ref("");
const newAgentId = ref<string | null>(null);

function pick(id: string) {
  newAgentId.value = newAgentId.value === id ? null : id;
}

function submit() {
  emit("create", { title: newTitle.value.trim(), agentId: newAgentId.value });
}
</script>

<template>
  <div class="overlay" @click="emit('close')">
    <div class="sheet" @click.stop>
      <div class="sheet-title">新建会话</div>
      <div class="sheet-body">
        <div class="form-card" style="margin: 0 0 10px">
          <div class="form-row">
            <span class="form-label">会话标题（可选，不填默认用智能体名）</span>
            <input v-model="newTitle" class="form-input" placeholder="例如：帮我写周报" />
          </div>
        </div>
        <div class="form-card" style="margin: 0">
          <div
            v-for="a in agents"
            :key="a.id"
            class="cell"
            @click="pick(a.id)"
          >
            <Avatar :emoji="a.emoji" :color="a.color" size="sm" />
            <div class="cell-label">
              <div style="font-size: 15px">{{ a.name }}</div>
              <div style="font-size: 11px; color: var(--wx-text-sub); margin-top: 2px">{{ a.desc }}</div>
            </div>
            <svg v-if="newAgentId === a.id" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--wx-green)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#c4c4c4" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/></svg>
          </div>
        </div>
        <button class="btn btn-primary" style="width: 100%; margin: 14px 0 0" @click="submit">
          开始对话
        </button>
      </div>
    </div>
  </div>
</template>
