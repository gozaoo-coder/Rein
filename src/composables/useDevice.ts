import { ref, readonly } from "vue";

export interface DeviceInfo {
  platform: string;
  arch: string;
  isMobile: boolean;
  isDesktop: boolean;
}

const device = ref<DeviceInfo>({
  platform: "unknown",
  arch: "unknown",
  isMobile: false,
  isDesktop: true,
});

let initialized = false;

export function useDevice() {
  async function detect() {
    if (initialized) return;
    initialized = true;

    try {
      const { platform, arch } = await import("@tauri-apps/plugin-os");
      const osPlatform = await platform();
      const osArch = await arch();
      device.value = {
        platform: osPlatform,
        arch: osArch,
        isMobile: ["android", "ios"].includes(osPlatform),
        isDesktop: !["android", "ios"].includes(osPlatform),
      };
    } catch {
      const ua = navigator.userAgent;
      const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
      device.value = {
        platform: isMobile ? "mobile-web" : "desktop-web",
        arch: "unknown",
        isMobile,
        isDesktop: !isMobile,
      };
    }
  }

  if (!initialized) detect();

  return { device: readonly(device), detect };
}
