# 移动端权限设计

## 概述

Rein 作为健康/运动应用，需要获取多项系统权限才能正常运行。权限管理遵循"最小必要、按需请求、优雅降级"原则。

---

## 1. 权限需求清单

| 权限 | Android 权限名 | iOS 权限名 | 使用场景 | 必要性 |
|------|----------------|------------|----------|--------|
| 精确定位 | `ACCESS_FINE_LOCATION` | `NSLocationWhenInUseUsageDescription` | GPS 轨迹记录、配速计算 | 运动时必需 |
| 粗略定位 | `ACCESS_COARSE_LOCATION` | 同上 | 城市级定位、天气展示 | 辅助 |
| 麦克风 | `RECORD_AUDIO` | `NSMicrophoneUsageDescription` | AI 语音输入、语音指令 | 可选 |
| 后台服务 | `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` | `UIBackgroundModes` (location) | 运动时后台持续定位 | 运动时必需 |
| 蓝牙 | `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` | `NSBluetoothAlwaysUsageDescription` | 心率监测器连接 | 可选 |
| 通知 | `POST_NOTIFICATIONS` | — | 运动提醒、目标达成通知 | 可选 |
| 存储 | `READ_MEDIA_IMAGES` / `READ_MEDIA_AUDIO` | `NSPhotoLibraryUsageDescription` | 头像上传、音频文件导入 | 可选 |
| 网络 | `INTERNET` (默认授予) | — | AI 聊天、地图瓦片加载 | 必需 |
| 相机 | `CAMERA` | `NSCameraUsageDescription` | 运动拍照打卡 | 可选 |

---

## 2. 权限请求流程

### 2.1 设计原则

```
最小必要：只请求当前功能所需的权限
按需请求：首次使用相关功能时才请求，非启动时全量请求
优雅降级：用户拒绝权限后提供替代方案或明确说明影响
不重复骚扰：用户拒绝后不在当次会话内重复弹窗
```

### 2.2 请求流程图

```
用户触发功能
    │
    ▼
检查权限状态 ──→ 已授权 ──→ 执行功能
    │
    ▼ (未授权)
显示权限说明弹窗（解释为什么需要）
    │
    ▼
用户选择
    ├─→ 允许 ──→ 执行功能
    │
    └─→ 拒绝
         │
         ├─→ "不再询问" ──→ 引导至系统设置页
         │
         └─→ 仅本次拒绝 ──→ 展示降级方案
              │
              ▼
          示例：
          - GPS 拒绝 → 切换为手动记录模式
          - 麦克风拒绝 → 仅支持文字输入
          - 蓝牙拒绝 → 隐藏心率相关功能
```

### 2.3 前端实现

```typescript
// composables/usePermission.ts
import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";

export type PermissionName =
  | "location"
  | "microphone"
  | "bluetooth"
  | "notification"
  | "camera"
  | "storage";

export function usePermission(name: PermissionName) {
  const status = ref<"granted" | "denied" | "not-determined">("not-determined");

  async function check() {
    status.value = await invoke("check_permission", { name });
    return status.value;
  }

  async function request(): Promise<boolean> {
    // 首先检查当前状态
    await check();
    if (status.value === "granted") return true;

    // 弹出说明弹窗（由 UI 层实现）
    const userAgreed = await showPermissionRationale(name);
    if (!userAgreed) return false;

    // 发起系统级权限请求
    const result = await invoke<boolean>("request_permission", { name });
    status.value = result ? "granted" : "denied";

    if (!result) {
      // 引导用户去系统设置
      await openSystemSettings();
    }

    return result;
  }

  return { status, check, request };
}
```

---

## 3. Tauri 2.0 权限配置

### 3.1 Capabilities 声明

Tauri 2.0 使用 `capabilities/` 目录下的 JSON 文件声明权限。每个 capability 定义一组允许的 API 和权限范围：

```json
// src-tauri/capabilities/default.json
{
  "identifier": "default",
  "description": "默认能力集",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "location:default",
    "location:allow-get-current-position",
    "location:allow-watch-position",
    "notification:default",
    "notification:allow-notify",
    "notification:allow-request-permission",
    "fs:default",
    "fs:allow-read",
    "fs:allow-write",
    "audio:default",
    "bluetooth:default",
    "bluetooth:allow-scan",
    "bluetooth:allow-connect"
  ]
}
```

### 3.2 Android 权限配置

```xml
<!-- src-tauri/gen/android/app/src/main/AndroidManifest.xml -->
<manifest>
  <!-- 定位 -->
  <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
  <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />

  <!-- 后台服务 -->
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

  <!-- 蓝牙 -->
  <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
  <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

  <!-- 通知 -->
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

  <!-- 麦克风 -->
  <uses-permission android:name="android.permission.RECORD_AUDIO" />

  <!-- 存储 -->
  <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
  <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
</manifest>
```

### 3.3 iOS 权限配置

```xml
<!-- src-tauri/gen/ios/Rein/Info.plist -->
<dict>
  <!-- 定位 -->
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>Rein 需要获取您的位置信息来记录运动轨迹和计算距离</string>
  <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
  <string>Rein 需要在后台获取位置信息以持续记录您的运动轨迹</string>

  <!-- 蓝牙 -->
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>Rein 需要蓝牙权限来连接您的心率监测设备</string>

  <!-- 麦克风 -->
  <key>NSMicrophoneUsageDescription</key>
  <string>Rein 需要麦克风权限来支持语音输入功能</string>

  <!-- 相机 -->
  <key>NSCameraUsageDescription</key>
  <string>Rein 需要相机权限来拍摄运动打卡照片</string>

  <!-- 后台模式 -->
  <key>UIBackgroundModes</key>
  <array>
    <string>location</string>
    <string>audio</string>
    <string>fetch</string>
  </array>

  <!-- 通知 -->
  <key>NSUserNotificationsUsageDescription</key>
  <string>Rein 需要通知权限来发送运动提醒和目标达成通知</string>
</dict>
```

---

## 4. 各权限详细设计

### 4.1 定位权限（核心）

**请求时机**：用户点击"开始户外运动"时

**降级方案**：
- 仅粗略定位 → 显示城市级天气，不记录轨迹
- 定位完全拒绝 → 提供手动输入距离模式（跑步机场景）

**后台定位**：
- Android：通过前台服务（ForegroundService）+ 持续通知保持
- iOS：通过 `UIBackgroundModes: location` + `allowsBackgroundLocationUpdates`

### 4.2 麦克风权限（可选）

**请求时机**：用户首次点击 AI 聊天界面的语音输入按钮

**降级方案**：隐藏语音输入按钮，仅保留文字输入

### 4.3 蓝牙权限（可选）

**请求时机**：用户进入"连接设备"页面并选择扫描时

**降级方案**：不显示心率数据，运动记录照常工作

### 4.4 通知权限（可选）

**请求时机**：用户首次开启"运动提醒"功能时

**降级方案**：应用内提醒替代系统通知

---

## 5. 权限状态追踪

使用 Pinia store 持久化记录权限状态，避免重复请求：

```typescript
// stores/usePermissionStore.ts
import { defineStore } from "pinia";
import { ref } from "vue";

export const usePermissionStore = defineStore("permissions", () => {
  const locationGranted = ref<boolean | null>(null);
  const microphoneGranted = ref<boolean | null>(null);
  const bluetoothGranted = ref<boolean | null>(null);
  const notificationGranted = ref<boolean | null>(null);

  function setPermission(name: string, granted: boolean) {
    switch (name) {
      case "location":
        locationGranted.value = granted;
        break;
      case "microphone":
        microphoneGranted.value = granted;
        break;
      case "bluetooth":
        bluetoothGranted.value = granted;
        break;
      case "notification":
        notificationGranted.value = granted;
        break;
    }
  }

  return {
    locationGranted,
    microphoneGranted,
    bluetoothGranted,
    notificationGranted,
    setPermission,
  };
});
```

---

## 6. 平台差异处理

| 场景 | Android | iOS |
|------|---------|-----|
| 权限请求弹窗 | 系统对话框 + 自定义说明 | 系统对话框（自定义说明通过 Info.plist） |
| "不再询问" | 引导至应用设置页 | 引导至系统设置 |
| 后台定位 | 需单独申请 `ACCESS_BACKGROUND_LOCATION` | 通过 `NSLocationAlways` 描述 |
| 前台服务 | 必须显示持久通知 | N/A |
| 权限分组 | 分步请求，避免一次性弹多个 | 系统自动分组显示 |
