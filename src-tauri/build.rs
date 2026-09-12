use std::path::Path;

/// 当前构建的目标平台。**必须读 cargo 提供的环境变量而不是 `cfg!()`**：
/// build.rs 本身是为宿主平台编译的，`cfg!(target_arch)` 永远是宿主的值，
/// 交叉编译（Windows ARM64 / Android 都在本机 x64 上构建）时会判错目标。
fn target_os() -> String {
    std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default()
}

fn target_arch() -> String {
    std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default()
}

/// 端侧 embedding 的模型与 ONNX Runtime 运行库体积大且可复现，不入库（见 .gitignore），
/// 由 scripts/fetch-embed-model.mjs 与 scripts/fetch-ort-runtime.mjs 拉取。
///
/// 缺文件时 `include_bytes!` 抛出的报错只给一行路径，不易定位；这里提前拦一道，
/// 直接告诉使用者该跑哪条命令。
fn check_embed_assets() {
    let model_dir = Path::new("resources/models/bge-small-zh-v1.5");
    let mut missing: Vec<String> = Vec::new();

    for f in ["model_quantized.onnx", "tokenizer.json"] {
        if !model_dir.join(f).exists() {
            missing.push(model_dir.join(f).display().to_string());
        }
    }

    // 运行库按目标平台取：Windows 内嵌进二进制（x64 / ARM64 各一份），
    // Android 走 jniLibs 由系统加载器按名字找，非 Windows 桌面走系统路径。
    let ort_rel = match (target_os().as_str(), target_arch().as_str()) {
        ("windows", "x86_64") => Some("resources/ort/win-x64/onnxruntime.dll"),
        ("windows", "aarch64") => Some("resources/ort/win-arm64/onnxruntime.dll"),
        ("android", "aarch64") => Some("gen/android/app/src/main/jniLibs/arm64-v8a/libonnxruntime.so"),
        _ => None,
    };
    if let Some(p) = ort_rel {
        if !Path::new(p).exists() {
            missing.push(p.to_string());
        }
    }

    if !missing.is_empty() {
        panic!(
            "\n\n端侧 embedding 的素材缺失，构建无法继续：\n{}\n\n\
             请先执行（模型走 ModelScope，运行库走 GitHub Release / Maven）：\n  \
             node scripts/fetch-embed-model.mjs\n  \
             node scripts/fetch-ort-runtime.mjs --target all\n\n",
            missing
                .iter()
                .map(|m| format!("  - {m}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}

fn main() {
    check_embed_assets();
    println!("cargo:rerun-if-changed=resources/models");
    println!("cargo:rerun-if-changed=resources/ort");
    tauri_build::build()
}
