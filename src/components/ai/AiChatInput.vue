<script setup lang="ts">
/**
 * AiChatInput — 共享的 AI 输入 pill 组件
 *
 * 从 AIPage 的浮动输入栏抽离，供 AIPage / WorkoutAiPanel 复用。
 * 父组件负责定位（fixed / sheet 内），本组件只渲染输入条 + 预览 chips + (+) 菜单。
 *
 * 文件 / 文件夹拾取：
 *   项目当前未安装 @tauri-apps/plugin-dialog（Tauri 2 已将 dialog 拆为独立插件），
 *   且 web 构建无 Tauri 运行时。这里使用 HTML <input type="file"> 实现，
 *   在 Tauri webview 中由宿主拦截为原生选择器，与 AIPage 原有图片选择路径一致。
 */
import { computed, nextTick, ref, watch } from "vue";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import type { Citation, FileAttachment } from "@/types/ai";

const props = withDefaults(
  defineProps<{
    /** 文本（v-model） */
    modelValue: string;
    /** 待发送的图片（data URL 数组） */
    pendingImages?: string[];
    /** 待发送的引用 */
    pendingCitations?: Citation[];
    /** 待发送的文件 / 文件夹附件 */
    pendingAttachments?: FileAttachment[];
    /** 禁用输入（如未配置 / 发送中） */
    disabled?: boolean;
    /** 是否启用视觉模型（控制图片按钮显示） */
    vision?: boolean;
    /** 是否允许引用入口（运动面板默认也允许） */
    allowCitations?: boolean;
    placeholder?: string;
    /** 发送中（用于按钮 spinner） */
    sending?: boolean;
  }>(),
  {
    pendingImages: () => [],
    pendingCitations: () => [],
    pendingAttachments: () => [],
    disabled: false,
    vision: false,
    allowCitations: true,
    placeholder: "输入消息…",
    sending: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [v: string];
  send: [];
  addImages: [urls: string[]];
  addFiles: [files: FileAttachment[]];
  addFolder: [folder: FileAttachment];
  addCitation: [];
  removeImage: [idx: number];
  removeCitation: [idx: number];
  removeAttachment: [idx: number];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const showPlusSheet = ref(false);

/** 文件夹选择 input 的非标准属性（webkitdirectory / directory）通过 v-bind 透传，避免类型错误 */
const folderAttrs: Record<string, string> = {
  webkitdirectory: "",
  directory: "",
};

const localText = computed({
  get: () => props.modelValue,
  set: (v: string) => emit("update:modelValue", v),
});

const canSend = computed(() => {
  if (props.disabled || props.sending) return false;
  return localText.value.trim().length > 0
    || props.pendingImages.length > 0
    || props.pendingAttachments.length > 0;
});

function autoResize() {
  nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  });
}

watch(() => props.modelValue, () => autoResize());

function onInput(e: Event) {
  const t = e.target as HTMLTextAreaElement;
  localText.value = t.value;
  autoResize();
  // @ 触发引用选择器（交给父组件处理）
  if (props.allowCitations && t.value.endsWith("@")) {
    emit("addCitation");
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function submit() {
  if (!canSend.value) return;
  emit("send");
}

// ===== 图片选择（HTML file input，Tauri webview 会拦截为原生） =====
const imageInputEl = ref<HTMLInputElement | null>(null);

function pickImages() {
  showPlusSheet.value = false;
  nextTick(() => imageInputEl.value?.click());
}

function onImagesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  const urls: string[] = [];
  let remaining = 0;
  for (const f of Array.from(input.files)) {
    if (!f.type.startsWith("image/")) continue;
    remaining++;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        urls.push(reader.result);
      }
      remaining--;
      if (remaining === 0 && urls.length) {
        emit("addImages", urls);
      }
    };
    reader.readAsDataURL(f);
  }
  input.value = "";
}

// ===== 文件选择 =====
const fileInputEl = ref<HTMLInputElement | null>(null);

function pickFiles() {
  showPlusSheet.value = false;
  nextTick(() => fileInputEl.value?.click());
}

function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  const files: FileAttachment[] = [];
  for (const f of Array.from(input.files)) {
    files.push({
      name: f.name,
      kind: "file",
      size: f.size,
    });
  }
  if (files.length) emit("addFiles", files);
  input.value = "";
}

// ===== 文件夹选择（webkitdirectory） =====
const folderInputEl = ref<HTMLInputElement | null>(null);

function pickFolder() {
  showPlusSheet.value = false;
  nextTick(() => folderInputEl.value?.click());
}

function onFolderPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  // 通过 webkitRelativePath 还原文件夹名 + 子文件名
  const files = Array.from(input.files);
  let folderName = "文件夹";
  const children: string[] = [];
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    if (rel) {
      const segs = rel.split("/");
      if (segs.length > 1) {
        if (folderName === "文件夹") folderName = segs[0];
        children.push(segs.slice(1).join("/"));
      }
    } else {
      children.push(f.name);
    }
  }
  emit("addFolder", {
    name: folderName,
    kind: "folder",
    children: children.slice(0, 100),
  });
  input.value = "";
}

function openCitationPicker() {
  showPlusSheet.value = false;
  emit("addCitation");
}

function openPlusSheet() {
  showPlusSheet.value = true;
}

function closePlusSheet() {
  showPlusSheet.value = false;
}
</script>

<template>
  <div class="aci-wrap">
    <!-- 引用 chips 预览 -->
    <div v-if="pendingCitations.length" class="aci-chips">
      <div
        v-for="(c, i) in pendingCitations"
        :key="'c' + i"
        class="aci-chip aci-chip--cite"
      >
        <i class="bi bi-pin-angle" style="font-size:10px"></i>
        <span class="aci-chip-label">{{ c.type === 'conversation' ? c.fromTitle : '引用上文' }}</span>
        <button class="aci-chip-x" @click="emit('removeCitation', i)">×</button>
      </div>
    </div>

    <!-- 图片 chips 预览 -->
    <div v-if="pendingImages.length" class="aci-chips aci-chips--images">
      <div
        v-for="(url, i) in pendingImages"
        :key="'i' + i"
        class="aci-img-wrap"
      >
        <img :src="url" class="aci-img" alt="preview" />
        <button class="aci-img-x" @click="emit('removeImage', i)">×</button>
      </div>
    </div>

    <!-- 附件 chips 预览 -->
    <div v-if="pendingAttachments.length" class="aci-chips">
      <div
        v-for="(a, i) in pendingAttachments"
        :key="'a' + i"
        class="aci-chip aci-chip--attach"
      >
        <i :class="a.kind === 'folder' ? 'bi bi-folder' : 'bi bi-file-earmark'" style="font-size:11px"></i>
        <span class="aci-chip-label">{{ a.name }}</span>
        <button class="aci-chip-x" @click="emit('removeAttachment', i)">×</button>
      </div>
    </div>

    <!-- 输入条（pill 风格） -->
    <div class="aci-bar">
      <button class="aci-btn aci-plus" @click="openPlusSheet" title="附件 / 引用" :disabled="disabled">
        <i class="bi bi-plus-lg" style="font-size:20px"></i>
      </button>

      <textarea
        ref="textareaRef"
        v-model="localText"
        class="aci-text"
        :placeholder="placeholder"
        :disabled="disabled"
        rows="1"
        @keydown="onKeydown"
        @input="onInput"
      />

      <button
        class="aci-btn aci-send"
        :disabled="!canSend"
        @click="submit"
        aria-label="发送"
      >
        <i v-if="!sending" class="bi bi-send" style="font-size:18px"></i>
        <i v-else class="bi bi-arrow-repeat spin" style="font-size:18px"></i>
      </button>
    </div>

    <!-- 隐藏的文件选择 input -->
    <input
      ref="imageInputEl"
      type="file"
      accept="image/*"
      multiple
      class="aci-hidden"
      @change="onImagesPicked"
    />
    <input
      ref="fileInputEl"
      type="file"
      multiple
      class="aci-hidden"
      @change="onFilesPicked"
    />
    <input
      ref="folderInputEl"
      type="file"
      class="aci-hidden"
      multiple
      v-bind="folderAttrs"
      @change="onFolderPicked"
    />

    <!-- (+) 菜单 BottomSheet -->
    <BottomSheet
      :visible="showPlusSheet"
      title="添加到消息"
      :detents="['medium']"
      :default-detent="'medium'"
      @close="closePlusSheet"
      @update:visible="closePlusSheet"
    >
      <div class="aci-menu">
        <button v-if="vision" class="aci-menu-item" @click="pickImages">
          <i class="bi bi-camera" style="font-size:20px"></i>
          <span class="aci-menu-label">上传照片</span>
        </button>
        <button class="aci-menu-item" @click="pickFiles">
          <i class="bi bi-file-earmark" style="font-size:20px"></i>
          <span class="aci-menu-label">上传文件</span>
        </button>
        <button class="aci-menu-item" @click="pickFolder">
          <i class="bi bi-folder" style="font-size:20px"></i>
          <span class="aci-menu-label">选定文件夹</span>
        </button>
        <button v-if="allowCitations" class="aci-menu-item" @click="openCitationPicker">
          <i class="bi bi-pin-angle" style="font-size:20px"></i>
          <span class="aci-menu-label">引用历史对话</span>
        </button>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.aci-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}

.aci-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 4px;
}
.aci-chips--images {
  gap: 8px;
}

.aci-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px 3px 10px;
  border-radius: var(--radius-full, 999px);
  background: var(--card-bg);
  color: var(--color-warm);
  font-size: 11px;
  font-weight: var(--fw-medium);
  box-shadow: var(--card-shadow);
  max-width: 220px;
}
.aci-chip--attach {
  color: var(--color-text-secondary);
}
.aci-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aci-chip-x {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.aci-img-wrap {
  position: relative;
  width: 64px;
  height: 64px;
}
.aci-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-md);
  box-shadow: var(--card-shadow);
}
.aci-img-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-text);
  color: #fff;
  border: 2px solid var(--color-bg);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.aci-bar {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: var(--radius-full, 999px);
  background: var(--pill-bar-bg, rgba(255, 255, 255, 0.9));
  -webkit-backdrop-filter: blur(var(--pill-bar-blur, 24px)) saturate(180%);
  backdrop-filter: blur(var(--pill-bar-blur, 24px)) saturate(180%);
  box-shadow: var(--pill-bar-shadow, 0 4px 16px rgba(0, 0, 0, 0.08));
  border: 1px solid var(--material-thin-border, rgba(0, 0, 0, 0.06));
}

.aci-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--dur-fast);
  padding: 0;
}
.aci-btn:active {
  background: var(--bg-200);
  transform: scale(0.92);
}
.aci-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.aci-plus {
  color: var(--color-warm);
}

.aci-text {
  flex: 1;
  resize: none;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  padding: 8px 4px;
  font-size: var(--text-sm);
  line-height: 1.4;
  color: var(--color-text);
  min-height: 36px;
  max-height: 120px;
  outline: none;
  font-family: var(--font-sans);
}
.aci-text::placeholder {
  color: var(--color-text-tertiary);
}
.aci-text:disabled {
  opacity: 0.5;
}

.aci-send {
  background: var(--color-warm);
  color: #fff;
}
.aci-send:disabled {
  background: var(--bg-300, #d1d1d6);
  cursor: not-allowed;
}
.aci-send:not(:disabled):active {
  transform: scale(0.92);
}
.aci-send .spin {
  animation: aci-spin 1s linear infinite;
}
@keyframes aci-spin { to { transform: rotate(360deg); } }

.aci-hidden {
  display: none;
}

/* (+) 菜单 */
.aci-menu {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) 0;
}
.aci-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-md);
  cursor: pointer;
  border-radius: var(--radius-md);
  text-align: left;
  width: 100%;
}
.aci-menu-item:active {
  background: var(--bg-100, rgba(0, 0, 0, 0.04));
}
.aci-menu-item i {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-warm);
  background: var(--warm-50, rgba(255, 149, 0, 0.1));
  border-radius: 50%;
  flex-shrink: 0;
}
.aci-menu-label {
  flex: 1;
}
</style>
