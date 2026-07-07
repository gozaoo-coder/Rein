# 定位与地图 SDK 设计

## 概述

Rein 的户外运动功能（跑步、骑行、徒步）依赖 GPS 定位与地图渲染。系统需实现实时轨迹追踪、距离计算、配速统计，并在地图上可视化展示路线。

---

## 1. 功能范围

| 功能 | 说明 |
|------|------|
| GPS 实时追踪 | 运动过程中持续记录位置坐标 |
| 轨迹记录 | 保存完整的运动路径点序列 |
| 距离计算 | 基于坐标序列计算累计运动距离 |
| 配速/速度追踪 | 实时计算当前配速和平均配速 |
| 地图展示 | 展示运动轨迹、当前位置、路线规划 |
| 离线地图 | 支持离线地图包下载（可选） |
| 轨迹分享 | 导出轨迹为 GPX/KML 格式 |

---

## 2. 地图 SDK 选型

### 2.1 中国大陆：高德地图（AMap）

| 项目 | 说明 |
|------|------|
| SDK | 高德地图 Web JS API（WebView 方案）或 Native SDK |
| 坐标系 | GCJ-02（国测局坐标） |
| 服务 | 路线规划、逆地理编码、地图瓦片 |
| 费用 | 个人开发免费，日调用量有上限 |
| 优势 | 国内数据最全，POI 覆盖广，中文支持好 |

### 2.2 海外备选：OpenStreetMap + Leaflet

| 项目 | 说明 |
|------|------|
| SDK | Leaflet.js（WebView 方案） |
| 坐标系 | WGS-84 |
| 服务 | 开源地图瓦片，社区维护 |
| 费用 | 免费 |
| 优势 | 全球覆盖，无使用限制，离线友好 |

### 2.3 选型策略

```typescript
// services/mapProvider.ts
export function getMapProvider(): "amap" | "osm" {
  // 根据用户位置或设置选择地图提供商
  // 中国大陆用户默认使用高德地图
  // 海外用户使用 OpenStreetMap
  const locale = navigator.language || "zh-CN";
  if (locale.startsWith("zh")) {
    return "amap";
  }
  return "osm";
}
```

---

## 3. GPS 定位实现

### 3.1 定位数据结构

```rust
// src-tauri/src/models/gps.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpsPoint {
    /// 纬度
    pub latitude: f64,
    /// 经度
    pub longitude: f64,
    /// 海拔高度（米）
    pub altitude: Option<f64>,
    /// 精度（米）
    pub accuracy: f64,
    /// 速度（米/秒）
    pub speed: Option<f64>,
    /// 方向（度）
    pub bearing: Option<f64>,
    /// 时间戳（Unix 毫秒）
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkoutRoute {
    pub points: Vec<GpsPoint>,
    pub total_distance: f64,
    pub duration_seconds: u64,
}
```

### 3.2 Tauri 定位服务

```rust
// src-tauri/src/services/location.rs
use tauri::{AppHandle, Emitter};

pub struct LocationService {
    is_tracking: bool,
    route: WorkoutRoute,
}

impl LocationService {
    pub fn start_tracking(&mut self, app: &AppHandle) -> Result<(), String> {
        self.is_tracking = true;
        self.route = WorkoutRoute::new();

        // 启动 GPS 监听
        self.start_gps_listener(app);

        Ok(())
    }

    fn on_location_update(&mut self, point: GpsPoint, app: &AppHandle) {
        if !self.is_tracking {
            return;
        }

        // 过滤精度过低的点（> 50 米精度）
        if point.accuracy > 50.0 {
            return;
        }

        // 计算与上一个点的距离
        let segment_distance = if let Some(last) = self.route.points.last() {
            haversine_distance(last.latitude, last.longitude, point.latitude, point.longitude)
        } else {
            0.0
        };

        // 过滤漂移点（单段距离 > 100 米且速度异常）
        if segment_distance > 100.0 {
            return;
        }

        self.route.points.push(point);
        self.route.total_distance += segment_distance;

        // 推送数据至前端
        let _ = app.emit("gps-update", &point);
        let _ = app.emit("workout-tick", WorkoutTick {
            duration: self.route.duration(),
            distance: self.route.total_distance,
            pace: self.route.current_pace(),
        });
    }

    pub fn stop_tracking(&mut self) -> WorkoutRoute {
        self.is_tracking = false;
        self.route.clone()
    }
}
```

### 3.3 Haversine 距离计算

```rust
/// 使用 Haversine 公式计算两点间球面距离（米）
pub fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS: f64 = 6_371_000.0; // 地球半径（米）

    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let delta_lat = (lat2 - lat1).to_radians();
    let delta_lon = (lon2 - lon1).to_radians();

    let a = (delta_lat / 2.0).sin().powi(2)
        + lat1_rad.cos() * lat2_rad.cos() * (delta_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

    EARTH_RADIUS * c
}
```

---

## 4. 轨迹数据处理

### 4.1 数据过滤策略

运动过程中 GPS 信号可能出现异常点，需要多层过滤：

| 过滤层 | 规则 | 说明 |
|--------|------|------|
| 精度过滤 | 丢弃 accuracy > 50m 的点 | 排除信号弱时的漂移 |
| 速度过滤 | 丢弃速度 > 60 km/h 的点（跑步/骑行） | 排除交通干扰 |
| 距离过滤 | 单段 > 100m 且时间 < 3s 丢弃 | 排除 GPS 跳跃 |
| 方向过滤 | 角度突变 > 135° 且无合理原因 | 排除信号漂移 |

### 4.2 路线平滑算法

使用卡尔曼滤波或移动平均平滑轨迹：

```rust
/// 简单移动平均平滑
pub fn smooth_route(points: &[GpsPoint], window_size: usize) -> Vec<GpsPoint> {
    points
        .windows(window_size)
        .map(|window| {
            let avg_lat: f64 = window.iter().map(|p| p.latitude).sum::<f64>() / window_size as f64;
            let avg_lon: f64 = window.iter().map(|p| p.longitude).sum::<f64>() / window_size as f64;
            let mid = &window[window_size / 2];
            GpsPoint {
                latitude: avg_lat,
                longitude: avg_lon,
                ..mid.clone()
            }
        })
        .collect()
}
```

---

## 5. 地图视图集成

### 5.1 方案：WebView + JS Map SDK

Tauri 应用内嵌入 WebView 加载地图，通过 JS Bridge 与 Rust 通信：

```vue
<!-- components/MapView.vue -->
<template>
  <div class="map-container">
    <iframe
      ref="mapFrame"
      :src="mapUrl"
      class="map-frame"
      @load="onMapLoaded"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { getMapProvider } from "@/services/mapProvider";

const props = defineProps<{
  center?: { lat: number; lng: number };
  zoom?: number;
  routePoints?: { lat: number; lng: number }[];
}>();

const mapFrame = ref<HTMLIFrameElement>();
const provider = getMapProvider();

const mapUrl = computed(() => {
  if (provider === "amap") {
    return "/maps/amap.html";
  }
  return "/maps/osm.html";
});

function onMapLoaded() {
  const iframe = mapFrame.value?.contentWindow;
  if (!iframe) return;

  // 通过 postMessage 发送路线数据给地图
  if (props.routePoints?.length) {
    iframe.postMessage(
      { type: "draw-route", points: props.routePoints },
      "*"
    );
  }
}
</script>
```

### 5.2 高德地图 HTML 桥接

```html
<!-- public/maps/amap.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script src="https://webapi.amap.com/maps?v=2.0&key=YOUR_AMAP_KEY"></script>
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const map = new AMap.Map('map', {
      zoom: 14,
      center: [116.397, 39.908],
    });

    // 接收来自 Tauri 的数据
    window.addEventListener('message', (e) => {
      if (e.data.type === 'draw-route') {
        drawRoute(e.data.points);
      } else if (e.data.type === 'update-center') {
        map.setCenter([e.data.lng, e.data.lat]);
      }
    });

    function drawRoute(points) {
      const path = points.map(p => new AMap.LngLat(p.lng, p.lat));
      const polyline = new AMap.Polyline({
        path: path,
        strokeColor: '#4f46e5',
        strokeWeight: 6,
        lineJoin: 'round',
      });
      map.add(polyline);
      map.setFitView();
    }
  </script>
</body>
</html>
```

### 5.3 OpenStreetMap HTML 桥接

```html
<!-- public/maps/osm.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9/dist/leaflet.js"></script>
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const map = L.map('map').setView([39.908, 116.397], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    window.addEventListener('message', (e) => {
      if (e.data.type === 'draw-route') {
        const latlngs = e.data.points.map(p => [p.lat, p.lng]);
        L.polyline(latlngs, { color: '#4f46e5', weight: 6 }).addTo(map);
        map.fitBounds(L.latLngBounds(latlngs));
      }
    });
  </script>
</body>
</html>
```

---

## 6. IPC 命令定义

| 命令 | 方向 | 参数 | 返回值 | 说明 |
|------|------|------|--------|------|
| `get_current_location` | invoke | - | `Result<GpsPoint>` | 获取当前位置 |
| `start_location_tracking` | invoke | `{ interval_ms?: number }` | `Result<()>` | 开始持续定位 |
| `stop_location_tracking` | invoke | - | `Result<WorkoutRoute>` | 停止定位，返回路线 |
| `reverse_geocode` | invoke | `{ lat, lng }` | `Result<String>` | 逆地理编码（坐标 → 地址） |
| `calculate_distance` | invoke | `{ points: GpsPoint[] }` | `Result<f64>` | 计算总距离 |
| `export_route_gpx` | invoke | `{ route: WorkoutRoute, path: string }` | `Result<()>` | 导出 GPX 文件 |
| `gps-update` | event | `GpsPoint` | - | GPS 坐标实时推送 |
| `workout-tick` | event | `{ duration, distance, pace }` | - | 运动数据定时推送 |

---

## 7. 前端 LocationStore

```typescript
// stores/useLocationStore.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface GpsPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy: number;
  speed?: number;
  bearing?: number;
  timestamp: number;
}

export interface WorkoutTick {
  duration: number;
  distance: number;
  pace: number; // min/km
}

export const useLocationStore = defineStore("location", () => {
  const currentPoint = ref<GpsPoint | null>(null);
  const routePoints = ref<GpsPoint[]>([]);
  const isTracking = ref(false);
  const totalDistance = ref(0);
  const duration = ref(0);
  const currentPace = ref(0);

  async function startTracking() {
    await invoke("start_location_tracking", { interval_ms: 1000 });
    isTracking.value = true;
  }

  async function stopTracking() {
    const route = await invoke<GpsPoint[]>("stop_location_tracking");
    isTracking.value = false;
    return route;
  }

  async function initEventListener() {
    await listen<GpsPoint>("gps-update", (e) => {
      currentPoint.value = e.payload;
      routePoints.value.push(e.payload);
    });

    await listen<WorkoutTick>("workout-tick", (e) => {
      duration.value = e.payload.duration;
      totalDistance.value = e.payload.distance;
      currentPace.value = e.payload.pace;
    });
  }

  return {
    currentPoint,
    routePoints,
    isTracking,
    totalDistance,
    duration,
    currentPace,
    startTracking,
    stopTracking,
    initEventListener,
  };
});
```

---

## 8. 性能优化

| 优化项 | 策略 |
|--------|------|
| 定位频率 | 跑步/骑行 1s/次，步行 3s/次，按运动类型动态调整 |
| 数据量控制 | 路线点超过 10000 时进行 Douglas-Peucker 简化 |
| 地图渲染 | WebView 按需加载，非地图页面不初始化 |
| 电量优化 | 锁屏后降低定位频率至 5s/次 |
| 离线支持 | 缓存最近使用的地图瓦片 |
| 冷启动 | 首次定位超时 10s 后提示用户手动选择位置 |

---

## 9. GPX 导出格式

运动轨迹支持导出为 GPX 标准格式，兼容主流运动平台（Strava、Nike Run Club 等）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rein">
  <trk>
    <name>晨跑 - 2026-07-07</name>
    <type>running</type>
    <trkseg>
      <trkpt lat="39.908" lon="116.397">
        <ele>43.5</ele>
        <time>2026-07-07T06:00:00Z</time>
      </trkpt>
      <trkpt lat="39.910" lon="116.399">
        <ele>43.8</ele>
        <time>2026-07-07T06:01:30Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
```
