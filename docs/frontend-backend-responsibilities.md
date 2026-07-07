# 前后端职责划分

## 概述

Rein 项目严格遵循前后端分离原则。前端（Vue）负责 UI 渲染与用户交互，后端（Tauri/Rust）负责所有系统级操作。两者通过 Tauri IPC Bridge 通信，互不越界。

---

## 1. 前端职责（Vue 层）

| 职责域 | 具体内容 |
|--------|----------|
| UI 渲染 | 页面组件渲染、布局切换（phone/pad/desktop） |
| 响应式布局 | 断点检测、自适应网格、卡片排列 |
| 卡片系统 | 数据卡片、统计卡片、进度卡片组件 |
| AI 聊天界面 | 对话气泡、输入框、流式响应渲染、Markdown 渲染 |
| 动画与过渡 | 页面切换动画、卡片入场动画、手势交互反馈 |
| 状态管理 | Pinia stores 管理全局/局部状态 |
| 路由导航 | Tab 切换、页面跳转、路由守卫 |
| 主题系统 | CSS Variables 令牌、暗色模式切换 |
| 表单处理 | 用户输入校验、数据格式化 |

### 1.1 前端不应做的事

- 直接访问文件系统
- 直接调用系统 API（GPS、蓝牙、音频）
- 直接操作 SQLite 数据库
- 管理应用权限
- 执行后台任务

---

## 2. 后端职责（Tauri/Rust 层）

| 职责域 | 具体内容 |
|--------|----------|
| 文件系统 | 读写本地文件、导出运动数据、缓存管理 |
| 原生 API 调用 | 封装所有平台原生接口 |
| 权限管理 | 检测、请求、追踪应用权限状态 |
| 后台音频播放 | 运动时的音乐/语音播报后台播放 |
| GPS/定位 | 位置获取、轨迹记录、距离计算 |
| 地图 SDK 集成 | 高德地图/OSM 渲染、路线显示 |
| 数据持久化 | SQLite 数据库操作（CRUD、迁移） |
| 后台任务 | 定时提醒、数据同步、健康数据采集 |
| 蓝牙通信 | 心率监测器等外设连接与数据接收 |
| 安全 | 敏感数据加密存储、API 密钥管理 |

### 2.1 后端不应做的事

- UI 渲染或样式计算
- 路由管理
- 业务表单校验（仅做数据层校验）

---

## 3. IPC Bridge 协议

### 3.1 通信模型

```
Vue (前端)                     Rust (后端)
┌─────────────┐    IPC invoke    ┌──────────────┐
│  组件层      │ ──────────────→  │  命令处理层    │
│  Composables│                  │  commands/    │
│  Stores      │ ←────────────── │  services/    │
└─────────────┘   IPC events     └──────────────┘
```

### 3.2 调用约定

前端通过 `@tauri-apps/api/core` 的 `invoke` 函数调用后端命令：

```typescript
// 前端调用
import { invoke } from "@tauri-apps/api/core";

// 获取运动历史记录
const records = await invoke<WorkoutRecord[]>("get_workout_records", {
  limit: 20,
  offset: 0,
});

// 开始运动录制
await invoke("start_workout", {
  type: "running",
  enableGps: true,
});
```

后端通过 `#[tauri::command]` 宏注册命令：

```rust
#[tauri::command]
fn get_workout_records(
    limit: u32,
    offset: u32,
    state: State<Database>,
) -> Result<Vec<WorkoutRecord>, String> {
    state
        .get_records(limit, offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_workout(
    type: String,
    enable_gps: bool,
    state: State<WorkoutService>,
) -> Result<(), String> {
    state.start(type, enable_gps)
}
```

### 3.3 事件推送（后端 → 前端）

后端通过 Tauri Event System 向前端推送实时数据：

```rust
// Rust 端发射事件
app.emit("gps-update", GpsPoint { lat: 39.9, lng: 116.4 })?;
app.emit("heart-rate", HeartRate { bpm: 72 })?;
app.emit("workout-tick", WorkoutTick { duration: 120, distance: 800.5 })?;
```

```typescript
// Vue 端监听事件
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<GpsPoint>("gps-update", (event) => {
  locationStore.addPoint(event.payload);
});

// 组件卸载时取消监听
onUnmounted(() => unlisten());
```

### 3.4 命令注册表

所有 IPC 命令集中管理，按功能域分组：

| 域 | 命令 | 方向 | 说明 |
|----|------|------|------|
| 运动记录 | `start_workout` | invoke | 开始运动录制 |
| 运动记录 | `stop_workout` | invoke | 停止运动录制 |
| 运动记录 | `get_workout_records` | invoke | 查询历史记录 |
| 运动记录 | `workout-tick` | event | 运动数据实时推送 |
| 定位 | `get_current_location` | invoke | 获取当前位置 |
| 定位 | `gps-update` | event | GPS 坐标流 |
| 音频 | `play_audio` | invoke | 播放音频 |
| 音频 | `pause_audio` | invoke | 暂停播放 |
| 音频 | `set_volume` | invoke | 设置音量 |
| 音频 | `audio-state-changed` | event | 播放状态变更 |
| 权限 | `check_permission` | invoke | 检查权限状态 |
| 权限 | `request_permission` | invoke | 请求权限 |
| 蓝牙 | `scan_devices` | invoke | 扫描蓝牙设备 |
| 蓝牙 | `connect_device` | invoke | 连接设备 |
| 蓝牙 | `heart-rate` | event | 心率数据推送 |
| 数据 | `export_data` | invoke | 导出用户数据 |
| 数据 | `import_data` | invoke | 导入用户数据 |

---

## 4. 错误处理

### 4.1 后端错误返回

所有 Tauri 命令返回 `Result<T, String>`，错误序列化为字符串：

```rust
#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    validate(&settings).map_err(|e| format!("参数校验失败: {}", e))?;
    persist(&settings).map_err(|e| format!("存储失败: {}", e))
}
```

### 4.2 前端错误捕获

前端统一通过 try-catch 捕获并展示错误：

```typescript
async function saveSettings(settings: Settings) {
  try {
    await invoke("save_settings", { settings });
    showToast("保存成功", "success");
  } catch (err) {
    showToast(String(err), "error");
  }
}
```

---

## 5. 数据流向总览

```
┌─────────────────────────────────────────────────────┐
│                    Vue 前端                          │
│                                                     │
│  组件 → Composable → Pinia Store ──→ invoke()      │
│         ↑                                  │        │
│         └── listen(event) ←──────────────┘        │
└─────────────────────────┬───────────────────────────┘
                          │ IPC (serde 序列化)
┌─────────────────────────┴───────────────────────────┐
│                   Rust 后端                           │
│                                                     │
│  Tauri Command → Service → Repository → SQLite       │
│       ↓                                             │
│  Tauri Event ←──────────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```
