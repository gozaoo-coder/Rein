# 开发指南

## 概述

本文档为 Rein 项目的开发环境搭建、项目结构说明和编码规范指南。面向新加入项目的开发者，帮助快速上手。

---

## 1. 前置依赖

| 依赖 | 最低版本 | 用途 | 安装方式 |
|------|----------|------|----------|
| Node.js | 18.0+ | 前端构建、包管理 | [nodejs.org](https://nodejs.org) |
| npm | 9.0+ | 包管理器（随 Node.js 安装） | — |
| Rust | 1.70+ | Tauri 后端编译 | [rustup.rs](https://rustup.rs) |
| Tauri CLI | 2.0+ | 构建与开发工具 | `cargo install tauri-cli` |
| Android Studio | 2023+ | Android 构建（仅移动端开发） | [developer.android.com](https://developer.android.com) |
| Xcode | 15+ | iOS 构建（仅 macOS 移动端开发） | Mac App Store |
| VS Code | 最新 | 推荐编辑器 | — |

### 1.1 推荐插件

| 插件 | 用途 |
|------|------|
| Volar (Vue) | Vue 3 语法支持 |
| rust-analyzer | Rust 语言服务 |
| Tauri | Tauri 专有支持 |
| ESLint | 代码风格检查 |
| Prettier | 代码格式化 |

---

## 2. 环境搭建

### 2.1 克隆项目

```bash
git clone <repo-url> Rein
cd Rein
```

### 2.2 安装前端依赖

```bash
npm install
```

### 2.3 编译 Rust 后端

首次构建会自动下载 Rust 依赖：

```bash
cd src-tauri
cargo build
```

### 2.4 启动开发服务器

```bash
# 同时启动 Vite 前端和 Tauri 后端
npm run tauri dev
```

启动后：
- Vite Dev Server 运行于 `http://localhost:1420`
- Tauri 窗口自动打开，内嵌 WebView 加载前端页面
- 前端代码修改支持 HMR 热更新
- Rust 代码修改需重新编译（约 3-10s）

### 2.5 移动端开发环境

**Android:**

1. 安装 Android Studio
2. 通过 SDK Manager 安装：
   - Android SDK Platform 34
   - Android Build Tools 34
   - Android Emulator
   - NDK (Rust 交叉编译需要)
3. 创建虚拟设备（AVD）或连接真机

```bash
# 初始化 Android 项目（首次）
npm run tauri android init

# 在模拟器/真机上运行
npm run tauri android dev
```

**iOS (仅 macOS):**

```bash
# 初始化 iOS 项目（首次）
npm run tauri ios init

# 在模拟器上运行
npm run tauri ios dev
```

---

## 3. 项目目录结构

```
Rein/
├── src/                        # ====== 前端源码 ======
│   ├── main.ts                 # 应用入口，挂载 Vue 实例
│   ├── App.vue                 # 根组件，断点自适应布局入口
│   │
│   ├── router/                 # 路由配置
│   │   └── index.ts            # 路由表定义、导航守卫
│   │
│   ├── stores/                 # Pinia 状态仓库
│   │   ├── useUserStore.ts     # 用户信息、偏好设置
│   │   ├── useWorkoutStore.ts  # 运动状态、历史记录
│   │   ├── useAudioStore.ts    # 音频播放状态
│   │   ├── useLocationStore.ts# 定位与轨迹数据
│   │   ├── useAiChatStore.ts   # AI 对话状态
│   │   └── usePermissionStore.ts # 权限状态追踪
│   │
│   ├── composables/            # 可组合函数
│   │   ├── useBreakpoint.ts    # 响应式断点检测
│   │   └── usePermission.ts    # 权限请求封装
│   │
│   ├── layouts/                # 响应式布局组件
│   │   ├── PhoneLayout.vue     # 手机布局（底部 Tab 导航）
│   │   ├── PadLayout.vue       # 平板布局（侧边栏/双栏）
│   │   └── DesktopLayout.vue   # 桌面布局（宽屏多栏）
│   │
│   ├── pages/                  # 页面组件（路由级）
│   │   ├── SportPage.vue       # 运动主页
│   │   ├── HealthPage.vue      # 健康数据页
│   │   ├── AiPage.vue          # AI 助手页
│   │   ├── ProfilePage.vue     # 个人中心页
│   │   └── WorkoutDetailPage.vue # 运动详情页
│   │
│   ├── components/             # 通用 UI 组件
│   │   ├── ui/                 # 基础 UI（按钮、输入框、卡片）
│   │   ├── sport/              # 运动相关组件
│   │   └── chat/               # 聊天相关组件
│   │
│   ├── assets/                 # 静态资源
│   │   ├── icons/              # 图标资源
│   │   ├── fonts/              # 字体文件
│   │   └── styles/             # 全局样式、设计令牌
│   │
│   └── types/                  # TypeScript 类型定义
│       ├── gps.ts              # GPS 相关类型
│       ├── workout.ts          # 运动相关类型
│       └── audio.ts            # 音频相关类型
│
├── src-tauri/                  # ====== Rust 后端 ======
│   ├── Cargo.toml              # Rust 项目配置与依赖
│   ├── tauri.conf.json         # Tauri 应用配置（窗口、权限、打包）
│   ├── capabilities/           # Tauri 2.0 能力声明
│   │   └── default.json        # 默认权限集
│   │
│   ├── src/
│   │   ├── main.rs             # 应用入口（桌面）
│   │   ├── lib.rs              # 库入口，注册命令与事件
│   │   │
│   │   ├── commands/           # IPC 命令处理
│   │   │   ├── mod.rs
│   │   │   ├── workout.rs      # 运动相关命令
│   │   │   ├── location.rs     # 定位相关命令
│   │   │   ├── audio.rs        # 音频相关命令
│   │   │   └── permission.rs   # 权限相关命令
│   │   │
│   │   ├── services/           # 业务逻辑层
│   │   │   ├── mod.rs
│   │   │   ├── location.rs     # GPS 定位服务
│   │   │   ├── audio.rs        # 音频播放服务
│   │   │   ├── media_session.rs # 媒体会话管理
│   │   │   └── audio_focus.rs  # 音频焦点管理
│   │   │
│   │   ├── models/             # 数据模型
│   │   │   ├── mod.rs
│   │   │   ├── gps.rs          # GPS 数据结构
│   │   │   └── workout.rs      # 运动数据结构
│   │   │
│   │   └── db/                 # 数据库层
│   │       ├── mod.rs
│   │       └── migrations/     # 数据库迁移脚本
│   │
│   ├── gen/                    # Tauri 自动生成（勿手动修改）
│   │   ├── android/            # Android 工程文件
│   │   └── apple/              # iOS 工程文件
│   │
│   └── icons/                  # 应用图标（多尺寸）
│
├── rein-design/                # 设计稿（HTML 原型）
│   ├── pages/                  # 页面设计稿
│   └── partials/               # 组件设计稿片段
│
├── docs/                       # 项目文档
├── public/                     # 公共静态资源
│   └── maps/                   # 地图 HTML 桥接页
├── index.html                  # Vite 入口 HTML
├── vite.config.ts              # Vite 构建配置
├── tsconfig.json               # TypeScript 编译配置
├── tsconfig.node.json          # Node 端 TS 配置
├── package.json                # Node.js 依赖与脚本
├── .gitignore                  # Git 忽略规则
└── README.md                   # 项目说明
```

---

## 4. 编码规范

### 4.1 Vue 组件规范

**使用 Composition API + `<script setup>`:**

```vue
<!-- 推荐 -->
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

interface Props {
  title: string;
  count?: number;
}

const props = withDefaults(defineProps<Props>(), {
  count: 0,
});

const emit = defineEmits<{
  update: [value: string];
  delete: [id: number];
}>();

const data = ref<string>("");

const displayTitle = computed(() => `${props.title} (${props.count})`);

onMounted(() => {
  // 初始化逻辑
});
</script>

<template>
  <div class="card">
    <h2>{{ displayTitle }}</h2>
  </div>
</template>
```

**禁止事项:**
- 禁止使用 Options API（所有组件使用 Composition API）
- 禁止在 `<script>` 中使用 `this`
- 禁止在模板中使用复杂表达式，提取到 computed 中

### 4.2 单一职责原则

每个组件只做一件事：

```
SportPage.vue          ← 页面容器，组合子组件
├── WorkoutCard.vue    ← 单个运动记录卡片
├── StatsCard.vue      ← 统计数据卡片
├── StartButton.vue    ← 开始运动按钮
└── RouteMap.vue       ← 轨迹地图视图
```

### 4.3 Atomic CSS 样式规范

使用工具类 + CSS Variables，避免自定义 class 滥用：

```vue
<template>
  <!-- 推荐：工具类 + 设计令牌 -->
  <div class="flex items-center gap-2 p-4 rounded-lg bg-[var(--color-card)]">
    <span class="text-sm font-medium text-[var(--color-text-secondary)]">
      {{ label }}
    </span>
  </div>
</template>
```

**CSS 变量命名规范:**

```css
:root {
  /* 颜色 */
  --color-bg: #ffffff;
  --color-bg-secondary: #f5f5f5;
  --color-text: #1a1a2e;
  --color-text-secondary: #6b7280;
  --color-primary: #4f46e5;
  --color-primary-light: #818cf8;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-danger: #ef4444;

  /* 间距 */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;

  /* 圆角 */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* 阴影 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);
  --shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.12);
}
```

### 4.4 TypeScript 规范

- 所有 `.ts` 和 `.vue` 文件启用严格模式
- 使用 `interface` 而非 `type`（除非需要联合类型）
- IPC 调用必须定义返回类型

```typescript
// 推荐
interface WorkoutRecord {
  id: string;
  type: "running" | "cycling" | "walking";
  distance: number;
  duration: number;
  date: string;
}

const records = await invoke<WorkoutRecord[]>("get_workout_records", {
  limit: 20,
});

// 禁止
const records = await invoke("get_workout_records", { limit: 20 }); // 类型丢失
```

### 4.5 Rust 规范

- 所有 Tauri 命令返回 `Result<T, String>`
- 使用 `serde` 进行序列化/反序列化
- 错误信息使用中文，面向用户展示
- 使用 `#[cfg(target_os = "...")]` 处理平台差异

```rust
// 命令格式
#[tauri::command]
fn my_command(
    param: String,
    state: State<MyService>,
) -> Result<MyResponse, String> {
    state
        .do_something(&param)
        .map_err(|e| format!("操作失败: {}", e))
}
```

---

## 5. 构建命令

### 5.1 日常开发

```bash
# 启动 Web 开发服务器（仅前端，无 Tauri）
npm run dev

# 启动 Tauri 开发模式（前端 + 后端）
npm run tauri dev

# 代码检查
npm run lint

# 类型检查
npm run type-check
```

### 5.2 构建发布

```bash
# Windows 桌面端
npm run tauri build

# Android
npm run tauri android build          # Debug
npm run tauri android build --release # Release

# iOS (仅 macOS)
npm run tauri ios build               # Debug
npm run tauri ios build --release    # Release
```

### 5.3 产物位置

| 平台 | Debug 产物 | Release 产物 |
|------|-----------|-------------|
| Windows | `src-tauri/target/debug/Rein.exe` | `src-tauri/target/release/bundle/msi/` |
| Android | `src-tauri/gen/android/app/build/outputs/apk/debug/` | `src-tauri/gen/android/app/build/outputs/apk/release/` |
| iOS | Xcode 自动管理 | `src-tauri/gen/apple/build/` |

---

## 6. 调试技巧

### 6.1 前端调试

- 在 Tauri 窗口中右键 → 检查元素 → 打开 DevTools
- 或使用快捷键 `Ctrl + Shift + I`（Windows）/ `Cmd + Option + I`（macOS）

### 6.2 Rust 调试

```bash
# 查看后端日志（带颜色输出）
RUST_LOG=debug npm run tauri dev

# 特定模块日志
RUST_LOG=rein::services::location=trace npm run tauri dev
```

### 6.3 移动端调试

**Android:**
```bash
# 查看设备日志
adb logcat | grep "Rein"

# WebView 调试（Chrome）
# chrome://inspect → 选择设备 → inspect
```

**iOS:**
- Xcode → Window → Devices and Simulators → Open DevTools

---

## 7. Git 工作流

### 7.1 分支策略

| 分支 | 用途 | 命名规范 |
|------|------|----------|
| `main` | 稳定发布版本 | — |
| `develop` | 日常开发分支 | — |
| `feature/*` | 功能开发 | `feature/运动轨迹记录` |
| `fix/*` | 缺陷修复 | `fix/gps漂移过滤` |
| `docs/*` | 文档更新 | `docs/权限设计文档` |

### 7.2 提交规范

使用 Conventional Commits:

```
feat: 新增运动轨迹 GPX 导出功能
fix: 修复 GPS 定位精度过滤阈值过大问题
docs: 更新后台音频播放设计文档
refactor: 重构 Pinia store 拆分逻辑
style: 统一 CSS 变量命名格式
chore: 升级 Tauri 至 2.0.3
```

---

## 8. 常见问题

### Q: `cargo build` 报错链接失败

检查是否安装了 Visual Studio Build Tools（Windows），确保勾选 C++ 工具链。

### Q: `npm run tauri dev` 启动白屏

1. 检查 Vite Dev Server 是否运行在 `localhost:1420`
2. 检查 `tauri.conf.json` 中 `devUrl` 配置
3. 查看后端控制台是否有 Rust panic

### Q: Android 构建失败

1. 确认 Android SDK、NDK 已正确安装
2. 设置环境变量 `ANDROID_HOME`
3. 运行 `npm run tauri android dev` 查看详细错误

### Q: 热更新不生效

- Rust 代码修改后需等待重新编译（底部状态栏有进度）
- 仅前端 Vue/CSS 修改支持即时 HMR
- 添加新的 IPC 命令需修改 `lib.rs` 中的 `invoke_handler`，触发 Rust 重编译
