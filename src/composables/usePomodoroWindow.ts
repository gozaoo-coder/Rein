/**
 * usePomodoroWindow — 打开番茄钟
 * 桌面端（Tauri）创建新窗口，移动端/Web 路由跳转
 */
import { useDevice } from "@/composables/useDevice";

export async function openPomodoro(): Promise<void> {
  const { device } = useDevice();

  if (device.value.isDesktop) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // 若窗口已存在则聚焦
      const existing = await WebviewWindow.getByLabel("pomodoro");
      if (existing) {
        await existing.setFocus();
        return;
      }
      new WebviewWindow("pomodoro", {
        url: "/pomodoro",
        title: "番茄钟",
        width: 400,
        height: 680,
        minWidth: 320,
        minHeight: 500,
        resizable: true,
        decorations: false,
      });
      return;
    } catch {
      // Tauri 不可用时降级为路由跳转
    }
  }

  // 移动端 / Web：路由跳转
  const router = (await import("@/router")).default;
  await router.push("/pomodoro");
}
