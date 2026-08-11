<script setup lang="ts">
import { inject, onMounted, ref } from "vue";
import { api } from "../api";
import type { AppInfo } from "../types";

const showToast = inject<((text: string) => void) | undefined>("toast");

const info = ref<AppInfo | null>(null);
const confirmReset = ref(false);

onMounted(async () => {
  info.value = await api.appInfo();
});

async function resetAll() {
  confirmReset.value = false;
  await api.resetAll();
  info.value = await api.appInfo();
  showToast?.("已恢复出厂数据（重新生成示例数据）");
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="topbar-left" />
      <div class="topbar-title">程序设置</div>
      <div class="topbar-right" />
    </header>

    <div class="list-group">
      <div class="about-card">
        <div class="about-logo">R</div>
        <div class="about-name">Rein</div>
        <div class="about-ver">v{{ info?.version ?? "0.1.0" }} · Tauri 2 + Rig + Vue 3</div>
      </div>

      <div class="group-title">运行状态</div>
      <div class="form-card">
        <div class="cell" style="cursor: default">
          <span class="cell-label">当前模型</span>
          <span class="cell-value">{{ info?.provider }} / {{ info?.model }}</span>
        </div>
        <div class="cell" style="cursor: default">
          <span class="cell-label">会话数量</span>
          <span class="cell-value">{{ info?.session_count }} 个</span>
        </div>
        <div class="cell" style="cursor: default">
          <span class="cell-label">技术栈</span>
          <span class="cell-value">{{ info?.framework }}</span>
        </div>
      </div>

      <div class="group-title">数据</div>
      <div class="form-card">
        <div class="form-row" style="cursor: default">
          <span class="form-label">数据目录</span>
          <span class="mono" style="color: var(--wx-text-sub)">{{ info?.data_dir }}</span>
        </div>
      </div>

      <div class="group-title">危险操作</div>
      <button class="btn btn-danger" @click="confirmReset = true">恢复出厂数据（删除全部会话与配置）</button>
    </div>

    <div v-if="confirmReset" class="modal">
      <div class="modal-card">
        <div class="modal-title">确定恢复出厂？</div>
        <div class="modal-body" style="text-align: center; font-size: 13px; color: var(--wx-text-sub)">
          将删除所有会话、智能体与模型配置，并重新生成示例数据。
        </div>
        <div class="modal-actions">
          <button @click="confirmReset = false">取消</button>
          <button class="primary" style="color: var(--wx-red)" @click="resetAll">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>
