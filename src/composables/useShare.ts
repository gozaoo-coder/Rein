/**
 * useShare — 分享能力桥接层
 *
 * - 优先使用 navigator.share（Web Share API），Android Tauri WebView 与现代移动浏览器原生支持
 *   系统分享面板会自动列出 QQ / 微信 等目标应用
 * - 图片分享通过 navigator.canShare({ files }) 检测，SVG 由 Canvas 光栅化为 PNG
 * - 桌面/不支持环境回退到剪贴板复制 + 下载图片
 *
 * 与 ShareSheet 配合：ShareSheet 选择模式与渠道，useShare 执行实际发送。
 */
import type { ShareContent, UseShareResult } from "@/types/share";

const hasNavigator = typeof navigator !== "undefined";
const hasShare = hasNavigator && typeof navigator.share === "function";
const hasCanShare = hasNavigator && typeof navigator.canShare === "function";
const hasClipboard =
  hasNavigator && !!navigator.clipboard && typeof navigator.clipboard.writeText === "function";

function svgToBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const width = 1080;
    const height = 1920;
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("canvas 2d 不可用"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob 失败"));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG 加载失败"));
    };
    img.src = url;
  });
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间发起下载再释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useShare(): UseShareResult {
  const canShareNative = hasShare;
  const canShareFiles =
    hasCanShare && typeof File !== "undefined" && navigator.canShare({ files: [] });

  async function shareText(content: ShareContent): Promise<boolean> {
    if (hasShare) {
      try {
        await navigator.share({ title: content.title, text: content.text });
        return true;
      } catch (e) {
        // 用户取消分享会抛 AbortError — 视为非错误
        if (e instanceof Error && e.name === "AbortError") return false;
        // 其他错误继续走回退
        console.warn("[share] navigator.share failed, fallback to clipboard", e);
      }
    }
    return copyText(content);
  }

  async function shareImage(content: ShareContent): Promise<boolean> {
    if (!content.svg) return shareText(content);
    try {
      const blob = await svgToBlob(content.svg);
      if (canShareFiles) {
        const file = new File([blob], `${content.imageName ?? "share"}.png`, {
          type: "image/png",
        });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: content.title,
            text: content.text,
            files: [file],
          });
          return true;
        }
      }
      // 不支持文件分享：保存图片 + 复制文本
      await downloadBlob(blob, `${content.imageName ?? "share"}.png`);
      if (hasClipboard) await navigator.clipboard.writeText(content.text);
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return false;
      console.error("[share] image share failed", e);
      return false;
    }
  }

  async function copyText(content: ShareContent): Promise<boolean> {
    if (hasClipboard) {
      try {
        await navigator.clipboard.writeText(content.text);
        return true;
      } catch (e) {
        console.warn("[share] clipboard failed", e);
      }
    }
    // 最终回退：execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = content.text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function saveImage(content: ShareContent): Promise<boolean> {
    if (!content.svg) return false;
    try {
      const blob = await svgToBlob(content.svg);
      await downloadBlob(blob, `${content.imageName ?? "share"}.png`);
      return true;
    } catch (e) {
      console.error("[share] save image failed", e);
      return false;
    }
  }

  return { canShareNative, canShareFiles, shareText, shareImage, copyText, saveImage };
}
