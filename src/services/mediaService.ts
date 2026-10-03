/**
 * HEIF/HEIC 解码（把 iPhone 的原图交给系统解码器转成 JPEG）。
 *
 * WebView 上没有 HEVC 解码器，这条命令是绕过它的唯一捷径：
 * Android 走 BitmapFactory、Windows 走 WIC（`modules/media`）。
 * **失败不是异常**：调用方会降级到内置的软件解码器（见 `utils/image.ts`）。
 *
 * 契约见 Rust `modules/media/commands.rs`。
 */
import { invoke } from './transport'

export interface HeifDecodeResult {
  /** 不含 data: 前缀的 JPEG base64 */
  jpegBase64: string
  width: number
  height: number
}

export const mediaService = {
  /**
   * HEIF/HEIC → JPEG。
   * - `maxEdge`：最长边上限（等比缩小，小于该值不放大）
   * - `quality`：JPEG 质量 0–100（Windows 侧由系统解码器自行取值，见 wic.rs 的说明）
   */
  async decodeHeif(base64: string, maxEdge: number, quality = 90): Promise<HeifDecodeResult> {
    return invoke<HeifDecodeResult>('image_decode_heif', {
      dataBase64: base64,
      maxEdge,
      quality,
    })
  },
}
