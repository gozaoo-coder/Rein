# Rein 项目架构概览

## 1. 项目简介

Rein 是一款跨平台健康/运动应用，覆盖运动记录、AI 健康顾问、音频播放、GPS 轨迹追踪等功能。基于 Vite + Vue 3 + Tauri 2.0 构建，支持 Windows 桌面端、Android、iOS 及折叠屏设备。

---

## 2. 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 构建工具 | Vite | 极速 HMR，原生 ESM 支持 |
| 前端框架 | Vue 3 (Composition API + TypeScript) | 类型安全，逻辑复用强 |
| 状态管理 | Pinia | Vue 官方推荐，支持 DevTools |
| 路由 | Vue Router 4 | 支持 tab 式导航与嵌套路由 |
| 桌面/移动壳 | Tauri 2.0 | Rust 后端，体积极小，原生能力 |
| 后端语言 | Rust | 高性能、内存安全，Tauri 原生语言 |
| 持久化 | SQLite (via rusqlite) | 本地嵌入式数据库，零配置 |
| 样式方案 | Atomic CSS + CSS Variables | 设计令牌驱动，响应式断点系统 |

---

## 3. Monorepo 结构

```
Rein/
├── src/                    # Vue 前端源码
│   ├── App.vue             # 根组件（断点自适应布局入口）
│   ├── main.ts             # 应用入口
│   ├── router/             # 路由配置
│   │   └── index.ts
│   ├── stores/             # Pinia 状态仓库
│   ├── composables/        # 可组合函数（useBreakpoint 等）
│   ├── layouts/             # 响应式布局组件
│   │   ├── PhoneLayout.vue
│   │   ├── PadLayout.vue
│   │   └── DesktopLayout.vue
│   ├── pages/              # 页面组件
│   ├── components/          # 通用 UI 组件
│   ├── assets/             # 静态资源（图标、字体）
│   └── types/              # TypeScript 类型定义
│
├── src-tauri/              # Rust 后端 / Tauri 核心
│   ├── Cargo.toml          # Rust 依赖配置
│   ├── tauri.conf.json     # Tauri 应用配置
│   ├── capabilities/       # Tauri 2.0 权限能力声明
│   ├── src/
│   │   ├── main.rs         # Rust 入口
│   │   ├── lib.rs          # 库入口，注册命令
│   │   ├── commands/        # IPC 命令处理
│   │   ├── models/          # 数据模型
│   │   ├── services/        # 业务逻辑层
│   │   └── plugins/         # 自定义 Tauri 插件
│   └── icons/              # 应用图标资源
│
├── rein-design/            # 设计稿（HTML 原型）
│   ├── pages/
│   └── partials/
│
├── docs/                   # 项目文档
├── public/                 # 静态公共资源
├── index.html              # Vite 入口 HTML
├── vite.config.ts          # Vite 配置
├── tsconfig.json           # TypeScript 配置
├── package.json            # Node.js 依赖
└── .gitignore
```

### 3.1 前后端分离原则

- **src/** — 纯前端代码，不直接调用任何系统 API，通过 Tauri IPC 与后端通信
- **src-tauri/** — 纯后端代码，负责所有系统级操作（文件、权限、GPS、音频等）

---

## 4. 跨平台策略

### 4.1 目标平台

| 平台 | 最低版本 | 说明 |
|------|----------|------|
| Windows | Windows 10 1809+ | 桌面端主战场 |
| Android | API 24+ (Android 7.0) | 移动端主战场 |
| iOS | iOS 15+ | 移动端备选 |
| 折叠屏 | - | 通过断点系统自适应 |

### 4.2 Tauri 2.0 跨平台能力

Tauri 2.0 统一了桌面和移动端的构建流程。核心差异通过条件编译和平台检测处理：

```rust
#[cfg(target_os = "android")]
fn mobile_specific_init() { /* Android 特有逻辑 */ }

#[cfg(target_os = "ios")]
fn mobile_specific_init() { /* iOS 特有逻辑 */ }

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn desktop_specific_init() { /* 桌面特有逻辑 */ }
```

---

## 5. 响应式设计策略

### 5.1 断点系统

Rein 采用三级断点体系，通过 `useBreakpoint` composable 实时检测：

| 断点名称 | 宽度范围 | 布局模式 | 典型设备 |
|----------|----------|----------|----------|
| `phone` | < 768px | 单列竖屏布局 | 手机、小屏设备 |
| `pad` | 768px - 1280px | 双栏/自适应布局 | 平板、折叠屏展开态 |
| `desktop` | > 1280px | 宽屏多栏布局 | 桌面显示器、大屏 |

### 5.2 自适应布局入口

根组件 `App.vue` 根据断点动态切换顶层布局：

```vue
<script setup lang="ts">
import { useBreakpoint } from "@/composables/useBreakpoint";
import PhoneLayout from "@/layouts/PhoneLayout.vue";
import PadLayout from "@/layouts/PadLayout.vue";
import DesktopLayout from "@/layouts/DesktopLayout.vue";

const { mode } = useBreakpoint();
</script>

<template>
  <PhoneLayout v-if="mode === 'phone'" />
  <PadLayout v-else-if="mode === 'pad'" />
  <DesktopLayout v-else />
</template>
```

### 5.3 断点实现（useBreakpoint composable）

```typescript
// composables/useBreakpoint.ts
import { ref, onMounted, onUnmounted } from "vue";

export type BreakpointMode = "phone" | "pad" | "desktop";

export function useBreakpoint() {
  const mode = ref<BreakpointMode>("phone");

  function update() {
    const width = window.innerWidth;
    if (width < 768) mode.value = "phone";
    else if (width <= 1280) mode.value = "pad";
    else mode.value = "desktop";
  }

  onMounted(() => {
    update();
    window.addEventListener("resize", update);
  });

  onUnmounted(() => {
    window.removeEventListener("resize", update);
  });

  return { mode };
}
```

### 5.4 卡片系统

各页面采用卡片式组件设计：
- **phone**: 单列卡片，全宽展示
- **pad**: 双列网格，卡片自适应填充
- **desktop**: 三列/四列网格，信息密度更高

---

## 6. 状态管理（Pinia）

### 6.1 Store 划分

| Store | 职责 |
|-------|------|
| `useUserStore` | 用户信息、偏好设置、目标配置 |
| `useWorkoutStore` | 当前运动状态、历史记录 |
| `useAudioStore` | 播放队列、播放状态、音频焦点 |
| `useLocationStore` | GPS 坐标、轨迹数据、地图状态 |
| `useAiChatStore` | AI 对话历史、上下文管理 |
| `usePermissionStore` | 权限状态追踪 |

### 6.2 Store 示例

```typescript
// stores/useWorkoutStore.ts
import { defineStore } from "pinia";
import { ref } from "vue";

export const useWorkoutStore = defineStore("workout", () => {
  const isRecording = ref(false);
  const currentType = ref<string>("");
  const duration = ref(0);
  const distance = ref(0);

  function startWorkout(type: string) {
    isRecording.value = true;
    currentType.value = type;
    duration.value = 0;
    distance.value = 0;
  }

  function stopWorkout() {
    isRecording.value = false;
  }

  return { isRecording, currentType, duration, distance, startWorkout, stopWorkout };
});
```

---

## 7. 路由策略

### 7.1 Tab 式导航

Rein 采用底部 Tab 栏导航，分为 4 个主入口：

| Tab | 路由路径 | 页面 |
|-----|----------|------|
| 运动 | `/sport` | SportPage |
| 健康 | `/health` | HealthPage |
| AI 助手 | `/ai` | AiPage |
| 我的 | `/profile` | ProfilePage |

### 7.2 路由配置结构

```typescript
// router/index.ts
const routes = [
  {
    path: "/",
    redirect: "/sport",
  },
  {
    path: "/sport",
    name: "sport",
    component: () => import("@/pages/SportPage.vue"),
  },
  {
    path: "/sport/:id",
    name: "workout-detail",
    component: () => import("@/pages/WorkoutDetailPage.vue"),
  },
  {
    path: "/health",
    name: "health",
    component: () => import("@/pages/HealthPage.vue"),
  },
  {
    path: "/ai",
    name: "ai",
    component: () => import("@/pages/AiPage.vue"),
  },
  {
    path: "/profile",
    name: "profile",
    component: () => import("@/pages/ProfilePage.vue"),
  },
];
```

### 7.3 路由守卫

使用 `beforeEach` 守卫处理权限校验和页面切换动画：

```typescript
router.beforeEach((to) => {
  // 记录页面访问，触发统计
  // 权限敏感页面可在此拦截
});
```

---

## 8. 设计系统

Rein 使用 CSS Variables 作为设计令牌，确保跨平台视觉一致性：

```css
:root {
  --color-bg: #ffffff;
  --color-text: #1a1a2e;
  --color-primary: #4f46e5;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-danger: #ef4444;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.08);
}
```

---

## 9. 构建产物

| 平台 | 构建命令 | 产物 |
|------|----------|------|
| Web 调试 | `npm run dev` | Vite Dev Server |
| Windows | `npm run tauri build` | .msi / .exe 安装包 |
| Android | `npm run tauri android build` | .apk / .aab |
| iOS | `npm run tauri ios build` | .ipa |
