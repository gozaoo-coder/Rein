/**
 * 蓝牙心率广播设备绑定 — 模拟实现
 *
 * TODO（平台相关）：接入 Tauri BLE 插件 / 平台原生蓝牙
 *   - Android: tauri-plugin-bluetooth 或原生插件，扫描 standard HR Service (0x180D)
 *   - iOS: CoreBluetooth，HR Service 同上
 *   - Windows: Windows.Devices.Bluetooth
 *   - 桌面/移动统一对外接口：scan / connect / disconnect / onHr
 *
 * 当前提供模拟数据流，便于 UI 与统计流程打通。
 */

import { ref, onUnmounted, computed } from "vue";

export interface HrDevice {
  id: string;
  name: string;
  rssi: number;
}

export type HrConnectionState = "disconnected" | "scanning" | "connecting" | "connected";

const SIM_DEVICES: HrDevice[] = [
  { id: "hr-band-01", name: "Rein 心率带", rssi: -55 },
  { id: "hr-watch-02", name: "华为手表 GT", rssi: -62 },
  { id: "hr-armband-03", name: "小米手环", rssi: -70 },
];

export function useHrBroadcast() {
  const state = ref<HrConnectionState>("disconnected");
  const devices = ref<HrDevice[]>([]);
  const connectedDevice = ref<HrDevice | null>(null);
  const heartRate = ref<number | null>(null);

  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let hrTimer: ReturnType<typeof setInterval> | null = null;

  const isConnected = computed(() => state.value === "connected");

  function scan() {
    if (state.value === "scanning" || state.value === "connected") return;
    state.value = "scanning";
    devices.value = [];
    scanTimer = setTimeout(() => {
      devices.value = [...SIM_DEVICES];
      state.value = "disconnected";
    }, 1200);
  }

  function cancelScan() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (state.value === "scanning") state.value = "disconnected";
  }

  function connect(device: HrDevice) {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    state.value = "connecting";
    setTimeout(() => {
      connectedDevice.value = device;
      state.value = "connected";
      heartRate.value = 72;
      startHrStream();
    }, 800);
  }

  function disconnect() {
    state.value = "disconnected";
    connectedDevice.value = null;
    heartRate.value = null;
    if (hrTimer) {
      clearInterval(hrTimer);
      hrTimer = null;
    }
  }

  function startHrStream() {
    if (hrTimer) clearInterval(hrTimer);
    hrTimer = setInterval(() => {
      // 60-100 静息波动模拟
      const base = 75;
      const variance = Math.floor(Math.random() * 12) - 6;
      heartRate.value = Math.max(55, Math.min(120, base + variance));
    }, 1500);
  }

  onUnmounted(() => {
    if (scanTimer) clearTimeout(scanTimer);
    if (hrTimer) clearInterval(hrTimer);
  });

  return {
    state,
    devices,
    connectedDevice,
    heartRate,
    isConnected,
    scan,
    cancelScan,
    connect,
    disconnect,
  };
}
