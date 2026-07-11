import { ref, readonly } from "vue";

export interface DeviceInfo {
  platform: string;
  arch: string;
  isMobile: boolean;
  isDesktop: boolean;
}

function detectByUA(): DeviceInfo {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  return {
    platform: isMobile ? "mobile-web" : "desktop-web",
    arch: "unknown",
    isMobile,
    isDesktop: !isMobile,
  };
}

// 同步初始化：避免移动端首帧误渲染桌面标题栏
const device = ref<DeviceInfo>(detectByUA());

let initialized = false;

export function useDevice() {
  async function detect() {
    if (initialized) return;
    initialized = true;
    // UA 推断已足够覆盖桌面/移动平台：
    //   Tauri 桌面 WebView UA 不含 Android/iPhone/iPad → isDesktop
    //   Tauri Android/iOS WebView UA 含 Android/iPhone/iPad → isMobile
    // 如后续需精确 platform/arch，按需安装 @tauri-apps/plugin-os。
    device.value = detectByUA();
  }

  if (!initialized) detect();

  return { device: readonly(device), detect };
}
