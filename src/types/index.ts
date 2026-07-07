/** 断点设备类型 */
export type BreakpointMode = "phone" | "pad" | "desktop";

/** 安全区域边距 */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 地理位置坐标 */
export interface GeoPosition {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  timestamp: number;
}

/** 运动类型 */
export type SportType = "running" | "cycling" | "walking" | "hiking" | "swimming";

/** 运动记录 */
export interface SportRecord {
  id: string;
  type: SportType;
  startTime: number;
  endTime: number;
  duration: number; // 秒
  distance: number; // 米
  avgPace: number; // 秒/公里
  calories: number;
  route: GeoPosition[];
}

/** 健康数据 */
export interface HealthData {
  steps: number;
  heartRate: number;
  sleepMinutes: number;
  date: string;
}

/** 平台信息 */
export interface PlatformInfo {
  os: "windows" | "android" | "ios" | "unknown";
  isPhone: boolean;
  isPad: boolean;
  isDesktop: boolean;
  hasNotch: boolean;
}
