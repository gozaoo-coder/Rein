import { ref, readonly } from "vue";

export interface DeviceInfo {
  platform: string;
  arch: string;
  isMobile: boolean;
  isDesktop: boolean;
}

// 同步初始化：避免移动端首帧误渲染桌面标题栏
const initialIsMobile =
  typeof navigator !== "undefined" &&
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const device = ref<DeviceInfo>({
  platform: initialIsMobile ? "mobile-web" : "desktop-web",
  arch: "unknown",
  isMobile: initialIsMobile,
  isDesktop: !initialIsMobile,
});

let initialized = false;

export function useDevice() {
  async function detect() {
    if (initialized) return;
    initialized = true;

    try {
      // 运行时动态加载：plugin-os 未安装时降级到 UA 推断。
      // @vite-ignore 阻止 Rollup 静态解析（包未安装时 web 构建会失败）。
      const { platform, arch } = await import(/* @vite-ignore */ "@tauri-apps/plugin-os");
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
