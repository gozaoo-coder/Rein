//! Android 端 HEIF/HEIC → JPEG：借用框架自己的解码器。
//!
//! HEIF 从 Android 9（API 28）起由系统支持，**WebView 里的 Chromium 却始终没有**
//! HEVC 解码器 —— 所以同样一张 HEIC，系统相册打得开，网页 `<img>` 打不开。
//! 这里经 `with_webview` → `jni_handle().exec` 调 `android.graphics.BitmapFactory`
//! 走系统那条路，压成 JPEG 回给前端。
//!
//! 只碰**框架类**（`android.*` / `java.*`）：它们在任意 JNIEnv 上都能查到，
//! 不像应用类那样要经 `getAppClass` 换类加载器（见 `modules/tracking`），
//! 因此不必再新增一个 Kotlin 桥接文件。
//!
//! 解码分两趟：先用 `inJustDecodeBounds` 读尺寸算出 `inSampleSize`（按 2 的幂抽稀，
//! 避免 4800 万像素整图进内存），采样后仍大于目标再用 `createScaledBitmap` 精修。

use std::time::Duration;

use jni::objects::{JByteArray, JObject, JValue};
use jni::JNIEnv;

/// exec 是把闭包投递给 UI 线程（异步），等结果的耐心上限。
/// 软解一张 1200 万像素 HEIC 通常在 1 秒内，20 秒足够覆盖低端机的大图。
const WAIT: Duration = Duration::from_secs(20);

const FACTORY: &str = "android/graphics/BitmapFactory";
const OPTIONS: &str = "android/graphics/BitmapFactory$Options";
const BITMAP: &str = "android/graphics/Bitmap";
const DECODE_SIG: &str = "([BIILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;";

/// HEIF 解码入口：真正的 JNI 调用必须发生在 UI 线程上，结果经 channel 带回。
pub(crate) fn decode(
    webview: &tauri::Webview<tauri::Wry>,
    bytes: &[u8],
    max_edge: u32,
    quality: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    let payload = bytes.to_vec();
    let (tx, rx) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            platform.jni_handle().exec(move |env, _activity, _webview| {
                let res = transcode(env, &payload, max_edge, quality);
                // 接收端必定在等（见下方 recv_timeout）；提前离开说明调用方已超时退场
                let _ = tx.send(res);
            })
        })
        .map_err(|e| format!("无法投递到 WebView 线程：{e}"))?;
    rx.recv_timeout(WAIT)
        .map_err(|e| format!("HEIF 解码超时：{e}"))?
}

/** JNI 调用的统一出口：先把结果算出来，再送去归一错误（避开借用冲突） */
macro_rules! jni {
    ($env:expr, $what:expr, $call:expr) => {{
        let r = $call;
        trap(&$env, $what, r)
    }};
}

/* ---------- 以下都跑在 UI 线程上 ---------- */

fn transcode(
    env: &mut JNIEnv<'_>,
    bytes: &[u8],
    max_edge: u32,
    quality: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    let arr = jni!(env, "创建字节数组", env.new_byte_array(bytes.len() as i32))?;
    // JNI 的字节是 jbyte(i8)，这里是无符号：只重解释指针，长度不变
    let signed: &[i8] =
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const i8, bytes.len()) };
    jni!(env, "填充字节数组", env.set_byte_array_region(&arr, 0, signed))?;

    let opts = jni!(env, "创建解码参数", env.new_object(OPTIONS, "()V", &[]))?;
    jni!(
        env,
        "置 justDecodeBounds",
        env.set_field(&opts, "inJustDecodeBounds", "Z", JValue::Bool(1))
    )?;
    jni!(
        env,
        "读取图片边界",
        env.call_static_method(
            FACTORY,
            "decodeByteArray",
            DECODE_SIG,
            &[
                JValue::Object(arr.as_ref()),
                JValue::Int(0),
                JValue::Int(bytes.len() as i32),
                JValue::Object(&opts),
            ],
        )
    )?;
    let w = int_field(env, &opts, "outWidth")?;
    let h = int_field(env, &opts, "outHeight")?;
    if w <= 0 || h <= 0 {
        return Err("读不到图片尺寸：文件可能已损坏，或不是系统能识别的 HEIF/HEIC".to_string())
    }

    // 第二趟：按采样率真解码（采样率只认 2 的幂）
    let sample = sample_size(w as u32, h as u32, max_edge);
    jni!(
        env,
        "关闭 justDecodeBounds",
        env.set_field(&opts, "inJustDecodeBounds", "Z", JValue::Bool(0))
    )?;
    jni!(
        env,
        "置 inSampleSize",
        env.set_field(&opts, "inSampleSize", "I", JValue::Int(sample as i32))
    )?;
    let decoded = jni!(
        env,
        "解码 HEIF",
        env.call_static_method(
            FACTORY,
            "decodeByteArray",
            DECODE_SIG,
            &[
                JValue::Object(arr.as_ref()),
                JValue::Int(0),
                JValue::Int(bytes.len() as i32),
                JValue::Object(&opts),
            ],
        )
    )?
    .l()
    .map_err(|e| format!("解码 HEIF：{e}"))?;
    let mut bitmap = nonnull(env, decoded, "HEIF 解码结果")?;
    let mut size = bitmap_size(env, &bitmap)?;

    // 采样是 2 的幂，可能没落到目标边长：精修一次
    if std::cmp::max(size.0, size.1) > max_edge {
        let scale = max_edge as f32 / std::cmp::max(size.0, size.1) as f32;
        let tw = ((size.0 as f32 * scale).round() as u32).max(1);
        let th = ((size.1 as f32 * scale).round() as u32).max(1);
        let scaled = jni!(
            env,
            "缩放位图",
            env.call_static_method(
                BITMAP,
                "createScaledBitmap",
                "(Landroid/graphics/Bitmap;IIZ)Landroid/graphics/Bitmap;",
                &[
                    JValue::Object(&bitmap),
                    JValue::Int(tw as i32),
                    JValue::Int(th as i32),
                    JValue::Bool(1),
                ],
            )
        )?
        .l()
        .map_err(|e| format!("缩放位图：{e}"))?;
        let scaled = nonnull(env, scaled, "缩放结果")?;
        recycle(env, &bitmap);
        bitmap = scaled;
        size = (tw, th);
    }

    // HEIF 的旋转写在 EXIF 里，BitmapFactory 不代劳
    if let Some(deg) = exif_rotation(env, bytes).filter(|d| *d != 0) {
        let rotated = rotate(env, &bitmap, deg as f32)?;
        recycle(env, &bitmap);
        bitmap = rotated;
        // 带 Matrix 的 createBitmap 转 90° 时会真的换边，重新读才准
        size = bitmap_size(env, &bitmap)?;
    }

    let jpeg = compress(env, &bitmap, quality)?;
    recycle(env, &bitmap);
    Ok((jpeg, size.0, size.1))
}

/** 采样率：不超过目标边长的最接近 2 的幂 */
fn sample_size(w: u32, h: u32, max_edge: u32) -> u32 {
    let long = std::cmp::max(w, h);
    let mut sample = 1u32;
    while long.div_ceil(sample) > max_edge && sample < 64 {
        sample *= 2
    }
    sample
}

fn rotate<'local>(
    env: &mut JNIEnv<'local>,
    bitmap: &JObject<'_>,
    deg: f32,
) -> Result<JObject<'local>, String> {
    let matrix = jni!(env, "创建 Matrix", env.new_object("android/graphics/Matrix", "()V", &[]))?;
    jni!(
        env,
        "设置旋转角度",
        env.call_method(&matrix, "postRotate", "(F)V", &[JValue::Float(deg)])
    )?;
    let (w, h) = bitmap_size(env, bitmap)?;
    let out = jni!(
        env,
        "旋转位图",
        env.call_static_method(
            BITMAP,
            "createBitmap",
            "(Landroid/graphics/Bitmap;IIIILandroid/graphics/Matrix;Z)Landroid/graphics/Bitmap;",
            &[
                JValue::Object(bitmap),
                JValue::Int(0),
                JValue::Int(0),
                JValue::Int(w as i32),
                JValue::Int(h as i32),
                JValue::Object(&matrix),
                JValue::Bool(1),
            ],
        )
    )?
    .l()
    .map_err(|e| format!("旋转位图：{e}"))?;
    nonnull(env, out, "旋转结果")
}

fn compress(env: &mut JNIEnv<'_>, bitmap: &JObject<'_>, quality: u32) -> Result<Vec<u8>, String> {
    let fmt = jni!(
        env,
        "读取 JPEG 压缩格式",
        env.get_static_field(
            "android/graphics/Bitmap$CompressFormat",
            "JPEG",
            "Landroid/graphics/Bitmap$CompressFormat;",
        )
    )?
    .l()
    .map_err(|e| format!("读取 JPEG 压缩格式：{e}"))?;
    let bos = jni!(
        env,
        "创建输出流",
        env.new_object("java/io/ByteArrayOutputStream", "()V", &[])
    )?;
    let ok = jni!(
        env,
        "编码 JPEG",
        env.call_method(
            bitmap,
            "compress",
            "(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z",
            &[
                JValue::Object(&fmt),
                JValue::Int(quality as i32),
                JValue::Object(&bos),
            ],
        )
    )?
    .z()
    .map_err(|e| format!("编码 JPEG：{e}"))?;
    if !ok {
        return Err("位图编码 JPEG 失败".to_string())
    }
    let out = jni!(env, "读取编码结果", env.call_method(&bos, "toByteArray", "()[B", &[]))?
        .l()
        .map_err(|e| format!("读取编码结果：{e}"))?;
    jni!(env, "转换编码结果", env.convert_byte_array(JByteArray::from(out)))
}

/** EXIF 的 Orientation → 顺时针角度；读不到（HEIF 的 EXIF 不支持/被裁掉）就 None */
fn exif_rotation(env: &mut JNIEnv<'_>, bytes: &[u8]) -> Option<i32> {
    (|| -> Result<i32, String> {
        let arr = jni!(env, "创建字节数组", env.new_byte_array(bytes.len() as i32))?;
        let signed: &[i8] =
            unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const i8, bytes.len()) };
        jni!(env, "填充字节数组", env.set_byte_array_region(&arr, 0, signed))?;
        let stream = jni!(
            env,
            "创建输入流",
            env.new_object(
                "java/io/ByteArrayInputStream",
                "([B)V",
                &[JValue::Object(arr.as_ref())],
            )
        )?;
        let exif = jni!(
            env,
            "创建 ExifInterface",
            env.new_object(
                "android/media/ExifInterface",
                "(Ljava/io/InputStream;)V",
                &[JValue::Object(&stream)],
            )
        )?;
        let key = jni!(env, "创建字符串", env.new_string("Orientation"))?;
        let value = jni!(
            env,
            "读取 Orientation",
            env.call_method(
                &exif,
                "getAttributeInt",
                "(Ljava/lang/String;I)I",
                &[JValue::Object(&key), JValue::Int(1)],
            )
        )?
        .i()
        .map_err(|e| format!("读取 Orientation：{e}"))?;
        Ok(match value {
            3 => 180,
            6 => 90,
            8 => 270,
            _ => 0,
        })
    })()
    .ok()
}

fn bitmap_size(env: &mut JNIEnv<'_>, bitmap: &JObject<'_>) -> Result<(u32, u32), String> {
    let w = jni!(env, "读取位图宽", env.call_method(bitmap, "getWidth", "()I", &[]))?
        .i()
        .map_err(|e| format!("读取位图宽：{e}"))?;
    let h = jni!(env, "读取位图高", env.call_method(bitmap, "getHeight", "()I", &[]))?
        .i()
        .map_err(|e| format!("读取位图高：{e}"))?;
    Ok((w.max(0) as u32, h.max(0) as u32))
}

fn int_field(env: &mut JNIEnv<'_>, obj: &JObject<'_>, name: &str) -> Result<i32, String> {
    jni!(env, name, env.get_field(obj, name, "I"))?
        .i()
        .map_err(|e| format!("{name}：{e}"))
}

fn recycle(env: &mut JNIEnv<'_>, bitmap: &JObject<'_>) {
    let r = env.call_method(bitmap, "recycle", "()V", &[]);
    let _ = trap(env, "回收位图", r);
}

/** 空引用不是 Err（JNI 里它是合法返回值），要单独判 */
fn nonnull<'local>(
    _env: &mut JNIEnv<'local>,
    obj: JObject<'local>,
    what: &str,
) -> Result<JObject<'local>, String> {
    if obj.is_null() {
        Err(format!("{what}为空：系统没能解出这张图"))
    } else {
        Ok(obj)
    }
}

/** 失败或被 Java 抛异常都归一成中文文案，并保证不留待处理异常
 *  （留着会让下一次 JNI 调用直接崩进程 —— 这是最容易翻车的一处） */
fn trap<T>(env: &JNIEnv<'_>, what: &str, r: Result<T, jni::errors::Error>) -> Result<T, String> {
    match r {
        Ok(v) => Ok(v),
        Err(e) => {
            let _ = env.exception_clear();
            Err(format!("{what}：{e}"))
        }
    }
}
