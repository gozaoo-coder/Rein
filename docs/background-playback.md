# 后台音频播放设计

## 概述

Rein 支持在运动过程中后台播放音频内容，包括运动音乐、语音指导播报和播客。后台播放需在设备锁屏或应用切到后台时持续工作，并支持锁屏媒体控制。

---

## 1. 功能范围

| 功能 | 说明 |
|------|------|
| 音乐播放 | 用户自选音乐列表，运动时自动播放 |
| 语音指导 | 运动过程中自动播报配速、距离、心率等数据 |
| 播客支持 | 播放用户订阅的播客内容 |
| 锁屏控制 | 系统锁屏界面显示播放状态，支持播放/暂停/切歌 |
| 音量控制 | 运动时自动调节音量（语音指导时降低音乐音量） |

---

## 2. 技术方案

### 2.1 整体架构

```
┌─────────────────────────────────────────┐
│              Vue 前端                    │
│                                         │
│  AudioStore (Pinia)                     │
│  ├─ 播放列表管理                         │
│  ├─ 播放状态 UI                          │
│  └─ 用户交互（播放/暂停/切歌）            │
│        │                                │
│        │ invoke / event                 │
└────────┼────────────────────────────────┘
         │
┌────────┴────────────────────────────────┐
│           Rust 后端                      │
│                                         │
│  AudioService                           │
│  ├─ AudioEngine (rodio)                 │
│  ├─ MediaSession (平台原生)              │
│  ├─ AudioFocusManager                   │
│  └─ BackgroundTask                      │
│        │                                │
│        ▼                                │
│  系统音频输出                            │
└─────────────────────────────────────────┘
```

### 2.2 Rust 音频引擎

使用 `rodio` crate 作为音频解码和播放引擎：

```rust
// src-tauri/src/services/audio/mod.rs
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use std::fs::File;
use std::io::BufReader;

pub struct AudioEngine {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    sink: Option<Sink>,
}

impl AudioEngine {
    pub fn new() -> Result<Self, String> {
        let (stream, handle) = OutputStream::try_default()
            .map_err(|e| format!("音频设备初始化失败: {}", e))?;
        Ok(Self {
            _stream: stream,
            handle,
            sink: None,
        })
    }

    pub fn play_file(&mut self, path: &str) -> Result<(), String> {
        let file = File::open(path).map_err(|e| format!("文件打开失败: {}", e))?;
        let reader = BufReader::new(file);
        let source = Decoder::new(reader)
            .map_err(|e| format!("音频解码失败: {}", e))?;

        let sink = Sink::try_new(&self.handle)
            .map_err(|e| format!("播放器创建失败: {}", e))?;
        sink.append(source);
        sink.play();
        self.sink = Some(sink);
        Ok(())
    }

    pub fn pause(&self) {
        if let Some(ref sink) = self.sink {
            sink.pause();
        }
    }

    pub fn resume(&self) {
        if let Some(ref sink) = self.sink {
            sink.play();
        }
    }

    pub fn set_volume(&self, volume: f32) {
        if let Some(ref sink) = self.sink {
            sink.set_volume(volume);
        }
    }
}
```

---

## 3. Tauri 2.0 后台服务

### 3.1 Android 后台服务

运动时通过 Android 前台服务（Foreground Service）保持后台运行：

```rust
// src-tauri/src/services/background.rs
#[cfg(target_os = "android")]
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "android")]
pub fn start_foreground_service(app: &tauri::AppHandle) -> Result<(), String> {
    // 显示持久通知，保持服务活跃
    app.notification()
        .builder()
        .title("Rein 运动中")
        .body("正在记录您的运动数据...")
        .icon("icons/icon.png")
        .show()
        .map_err(|e| format!("通知显示失败: {}", e))?;

    // 启动前台服务（通过 Tauri 插件或 JNI 调用）
    start_location_foreground_service()
}
```

### 3.2 后台服务生命周期

```
用户点击"开始运动"
    │
    ▼
启动前台服务（Android）/ 后台任务（iOS）
    │
    ├─→ GPS 持续定位
    ├─→ 音频持续播放
    ├─→ 数据定时持久化
    └─→ 运动数据实时推送至前端
    │
用户点击"结束运动" / 应用被系统杀死
    │
    ▼
停止前台服务，清理资源，保存最终数据
```

---

## 4. 媒体会话集成（Media Session）

### 4.1 锁屏控制

通过系统媒体会话 API，在锁屏界面显示播放控件：

```rust
// src-tauri/src/services/media_session.rs

pub struct MediaSession {
    title: String,
    artist: String,
    album_art: Option<String>,
}

impl MediaSession {
    /// 更新锁屏显示的曲目信息
    pub fn update_metadata(&self, title: &str, artist: &str, art_path: Option<&str>) {
        #[cfg(target_os = "android")]
        self.update_android_metadata(title, artist, art_path);

        #[cfg(target_os = "ios")]
        self.update_ios_metadata(title, artist, art_path);
    }

    /// 设置播放状态（播放中/暂停）
    pub fn set_playback_state(&self, is_playing: bool) {
        #[cfg(target_os = "android")]
        self.update_android_playback_state(is_playing);

        #[cfg(target_os = "ios")]
        self.update_ios_playback_state(is_playing);
    }
}
```

### 4.2 锁屏控件支持

| 控件 | 支持的动作 |
|------|-----------|
| 播放/暂停 | 恢复/暂停当前曲目 |
| 上一曲 | 切换到上一首（仅播客/音乐模式） |
| 下一曲 | 切换到下一首（仅播客/音乐模式） |
| 进度条 | 拖动跳转播放位置（仅播客模式） |

---

## 5. 音频焦点管理（Audio Focus）

### 5.1 策略

运动场景下音频焦点管理至关重要：

```
场景 1: 用户运动中，来电进来
  → 暂停音乐 → 来电结束 → 恢复播放

场景 2: 语音指导播报
  → 音乐音量降至 30% → 语音播报（5秒）→ 音乐音量恢复

场景 3: 用户使用导航 App
  → 导航语音优先 → 音乐音量降至 20% → 导航语音结束 → 恢复

场景 4: 其他 App 获取焦点
  → 暂停播放 → 焦点返回 → 恢复播放
```

### 5.2 实现

```rust
// src-tauri/src/services/audio_focus.rs
pub struct AudioFocusManager {
    current_volume: f32,
    user_volume: f32,
}

impl AudioFocusManager {
    pub fn on_focus_gained(&mut self) {
        // 焦点回归，恢复用户设定的音量
        self.current_volume = self.user_volume;
    }

    pub fn on_focus_lost_transient(&mut self) {
        // 临时失去焦点（如导航语音），降低音量
        self.current_volume = self.user_volume * 0.2;
    }

    pub fn on_focus_lost(&mut self) {
        // 完全失去焦点（如来电），暂停播放
        // 由 AudioEngine 处理暂停
    }

    pub fn duck_for_voice_guidance(&mut self) {
        // 语音指导播报时降低音量
        self.current_volume = self.user_volume * 0.3;
    }

    pub fn restore_after_guidance(&mut self) {
        // 语音指导播报结束后恢复音量
        self.current_volume = self.user_volume;
    }
}
```

---

## 6. IPC 命令定义

| 命令 | 方向 | 参数 | 返回值 | 说明 |
|------|------|------|--------|------|
| `play_audio` | invoke | `{ path: string }` | `Result<()>` | 播放指定音频文件 |
| `pause_audio` | invoke | - | `Result<()>` | 暂停播放 |
| `resume_audio` | invoke | - | `Result<()>` | 恢复播放 |
| `stop_audio` | invoke | - | `Result<()>` | 停止播放并释放资源 |
| `set_volume` | invoke | `{ volume: f32 }` | `Result<()>` | 设置音量 (0.0 - 1.0) |
| `seek_to` | invoke | `{ position: u64 }` | `Result<()>` | 跳转到指定位置（ms） |
| `enqueue` | invoke | `{ paths: string[] }` | `Result<()>` | 添加播放队列 |
| `next_track` | invoke | - | `Result<()>` | 下一首 |
| `prev_track` | invoke | - | `Result<()>` | 上一首 |
| `audio-state-changed` | event | `{ playing, position, duration, track }` | - | 播放状态实时推送 |
| `audio-completed` | event | `{ track }` | - | 当前曲目播放完成 |
| `play_voice_guidance` | invoke | `{ text: string }` | `Result<()>` | 播放语音指导 |

---

## 7. 前端 AudioStore

```typescript
// stores/useAudioStore.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Track {
  id: string;
  title: string;
  artist: string;
  path: string;
  duration: number;
  artwork?: string;
}

export const useAudioStore = defineStore("audio", () => {
  const isPlaying = ref(false);
  const currentTrack = ref<Track | null>(null);
  const queue = ref<Track[]>([]);
  const position = ref(0);
  const duration = ref(0);
  const volume = ref(0.8);

  async function play(track: Track) {
    await invoke("play_audio", { path: track.path });
    currentTrack.value = track;
    isPlaying.value = true;
  }

  async function pause() {
    await invoke("pause_audio");
    isPlaying.value = false;
  }

  async function resume() {
    await invoke("resume_audio");
    isPlaying.value = true;
  }

  async function next() {
    await invoke("next_track");
  }

  async function setVolume(v: number) {
    volume.value = Math.max(0, Math.min(1, v));
    await invoke("set_volume", { volume: volume.value });
  }

  async function initEventListener() {
    await listen<{ playing: boolean; position: number; duration: number; track: Track }>(
      "audio-state-changed",
      (e) => {
        isPlaying.value = e.payload.playing;
        position.value = e.payload.position;
        duration.value = e.payload.duration;
        if (e.payload.track) currentTrack.value = e.payload.track;
      }
    );
  }

  return {
    isPlaying,
    currentTrack,
    queue,
    position,
    duration,
    volume,
    play,
    pause,
    resume,
    next,
    setVolume,
    initEventListener,
  };
});
```

---

## 8. 音频文件格式支持

| 格式 | 扩展名 | 说明 |
|------|--------|------|
| MP3 | `.mp3` | 通用格式，全平台支持 |
| AAC | `.m4a`, `.aac` | iOS 默认格式 |
| OGG | `.ogg` | 开源格式，Android 友好 |
| FLAC | `.flac` | 无损格式，按需支持 |
| WAV | `.wav` | 语音指导原始格式 |

---

## 9. 电量与性能优化

| 优化项 | 策略 |
|--------|------|
| 解码优化 | 使用硬件解码器，避免 CPU 软解码 |
| 缓冲策略 | 预加载下一首，减少 I/O 唤醒 |
| 后台降频 | 锁屏后降低状态推送频率（1s → 5s） |
| 无线音频 | 支持蓝牙耳机/扬声器低延迟模式 |
| 内存管理 | 播放完毕及时释放解码缓冲区 |
