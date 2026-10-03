//! Windows 桌面端 HEIF/HEIC → JPEG：经 WIC（Windows Imaging Component）走系统解码器。
//!
//! WebView2 走的就是 Chromium 那条路，同样解不了 HEVC；系统里其实有解码器，只是
//! WebView 不去用。这里 CoCreate 一个 WIC 工厂自己解。
//!
//! ⚠️ HEIF 解码器在 Windows 上是**可选组件**（Microsoft Store 的「HEIF 图片扩展」）。
//! 没装时 `CreateDecoderFromStream` 报 WINCODEC_ERR_COMPONENTNOTFOUND ——
//! 归一成中文提示并由前端降级（见 `src/utils/image.ts`），别当成「文件坏了」。
//!
//! 旋转**不在这里处理**：HEIF 的朝向写在容器的 transform（irot）里，符合规范的解码器
//! 应当自行应用，Windows 的 HEIF 解码器就是这么做的。Android 那条路是另一回事 ——
//! BitmapFactory 明确不看 EXIF/transform，必须自己补，见 android.rs。
//!
//! 质量**也不在这里调**：WIC 的 JPEG 编码器只认属性包里的 ImageQuality（一个 VT_R4 的
//! variant），为它引入 PropertyBag/PROPBAG2 两套构造不值当 —— 前端拿到图还会按自己的
//! 档位重压一次 JPEG（`bitmapToJpeg`），中间这档交给系统默认即可。

use windows::core::Interface;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IStream};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

/// WINCODEC_ERR_COMPONENTNOTFOUND：系统缺 HEIF 解码器（≈ 没装 HEIF 图片扩展）
const NO_CODEC: u32 = 0x8898_2F50;

pub(crate) fn decode(
    bytes: &[u8],
    max_edge: u32,
    _quality: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    let _com = ComGuard::init();
    // SAFETY: 所有 COM 调用都发生在本线程，且上面已经 CoInitialize 过
    unsafe { transcode(bytes, max_edge) }
}

/** 线程 COM 初始化的生命周期闸：本次调用结束时必须配对 CoUninitialize */
struct ComGuard(bool);

impl ComGuard {
    fn init() -> Self {
        // RPC_E_CHANGED_MODE：线程已经初始化过了（Tauri 的异步命令线程常见），不算失败
        let ok = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        Self(ok)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() }
        }
    }
}

unsafe fn transcode(bytes: &[u8], max_edge: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let factory: IWICImagingFactory = win(
        CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER),
        "创建影像工厂",
    )?;

    // 输入：内存流 → 解码器 → 首帧
    let input: IWICStream = win(factory.CreateStream(), "创建内存流")?;
    win(input.InitializeFromMemory(bytes), "装载 HEIF 数据")?;
    let decoder = win(
        factory.CreateDecoderFromStream(&input, std::ptr::null(), WICDecodeMetadataCacheOnLoad),
        "创建 HEIF 解码器",
    )?;
    let frame = win(decoder.GetFrame(0), "取首帧")?;
    let source: IWICBitmapSource = win_cast(frame.cast(), "取位图源")?;
    let mut width = 0u32;
    let mut height = 0u32;
    win(source.GetSize(&mut width, &mut height), "读图片尺寸")?;
    if width == 0 || height == 0 {
        return Err("图片尺寸为零：文件可能已损坏".to_string())
    }

    // 缩放：等比压到 maxEdge 以内（小于目标时不放大）
    let mut source = source;
    let long = width.max(height);
    if long > max_edge {
        let scale = max_edge as f64 / long as f64;
        let tw = ((width as f64 * scale).round() as u32).max(1);
        let th = ((height as f64 * scale).round() as u32).max(1);
        let scaler: IWICBitmapScaler = win(factory.CreateBitmapScaler(), "创建缩放器")?;
        win(
            scaler.Initialize(&source, tw, th, WICBitmapInterpolationModeLinear),
            "缩放位图",
        )?;
        source = win_cast(scaler.cast(), "取缩放结果")?;
        width = tw;
        height = th;
    }

    // 输出：HGLOBAL 内存流 → JPEG 编码器
    // 传空 HGLOBAL = 让 ole32 自己分配一块；fDeleteOnRelease=true 由 IStream 释放它
    let stream = win(
        CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true),
        "创建输出流",
    )?;
    let encoder = win(
        factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()),
        "创建 JPEG 编码器",
    )?;
    win(
        encoder.Initialize(&stream, WICBitmapEncoderNoCache),
        "初始化编码器",
    )?;
    let mut frame_out: Option<IWICBitmapFrameEncode> = None;
    win(
        encoder.CreateNewFrame(&mut frame_out, std::ptr::null_mut()),
        "创建编码帧",
    )?;
    let frame_out = frame_out.ok_or_else(|| "编码帧为空".to_string())?;
    win(frame_out.Initialize(None), "初始化编码帧")?;
    win(frame_out.SetSize(width, height), "设置编码尺寸")?;
    let mut pixel_format = GUID_WICPixelFormat24bppBGR;
    win(frame_out.SetPixelFormat(&mut pixel_format), "设置像素格式")?;
    win(frame_out.WriteSource(&source, std::ptr::null()), "写入像素")?;
    win(frame_out.Commit(), "提交编码帧")?;
    win(encoder.Commit(), "提交编码器")?;
    let jpeg = read_hglobal(&stream).map_err(|e| format!("读取 JPEG 结果：{e}"))?;

    Ok((jpeg, width, height))
}

/** COM 错误翻译成中文：优先识别「缺 HEIF 解码器」这个用户能自助解决的场景 */
fn win<T>(r: windows::core::Result<T>, what: &str) -> Result<T, String> {
    r.map_err(|e| {
        if e.code().0 as u32 == NO_CODEC {
            "系统缺少 HEIF 解码器：到 Microsoft Store 安装「HEIF 图片扩展」即可".to_string()
        } else {
            format!("{what}：{e}")
        }
    })
}

fn win_cast<T: Interface>(r: windows::core::Result<T>, what: &str) -> Result<T, String> {
    win(r, what)
}

/** 读回用 CreateStreamOnHGlobal 建的流里的内容 */
unsafe fn read_hglobal(stream: &IStream) -> Result<Vec<u8>, String> {
    let hglobal = win(GetHGlobalFromStream(stream), "取 HGLOBAL")?;
    let ptr = GlobalLock(hglobal);
    if ptr.is_null() {
        return Err("锁定 HGLOBAL 失败".to_string())
    }
    let len = GlobalSize(hglobal);
    let out = std::slice::from_raw_parts(ptr as *const u8, len).to_vec();
    let _ = GlobalUnlock(hglobal);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::decode;

    /// HEIC 样例：`npm run heic:fixture` 拉取。第三方二进制不入库（见 scripts/）。
    const FIXTURE: &str = "resources/test/heic/sample.heic";

    #[test]
    fn wic_turns_heic_into_scaled_jpeg() {
        let Ok(bytes) = std::fs::read(FIXTURE) else {
            // 没有样例设备繁杂：跳过而不是假装通过
            eprintln!("跳过：缺样例 {FIXTURE}，跑 `npm run heic:fixture` 拉一份再来");
            return
        };
        let (jpeg, w, h) = decode(&bytes, 480, 90).expect("WIC 应能把 HEIC 转成 JPEG");
        assert_eq!(w.max(h), 480, "应等比压到 maxEdge：{w}x{h}");
        assert!(jpeg.len() > 1024, "JPEG 体积不合理：{} 字节", jpeg.len());
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "开头不是 JPEG SOI");
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9], "结尾不是 EOI");
    }
}
