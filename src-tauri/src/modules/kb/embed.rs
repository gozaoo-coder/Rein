//! Embedding 三接口：进程内本地推理 / 云端 OpenAI 兼容端点 / 纯关键词（不嵌入）。
//!
//! **为什么是 ONNX Runtime + load-dynamic**：编译期不链接 ORT，运行时由我们显式加载，
//! 因此三条构建链路（Windows x64 / Windows ARM64 / Android aarch64）都不需要平台专属的
//! 链接配置。配合 `tokenizers` 的 `fancy-regex`（而非默认的 `onig`），整棵依赖树零 C 代码——
//! 实测三端交叉编译只需指定 NDK 链接器。详见 docs/kb-embed-benchmark.md。
//!
//! **模型与运行库都编进二进制**（`include_bytes!`），免去 tauri bundle.resources 的路径语义差异，
//! 也让 `tauri dev` 与打包后的行为完全一致。Android 例外：系统禁止从可写目录 dlopen，
//! 所以运行库必须走 jniLibs 由系统加载器按名字找，不能落盘再加载。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;
use tokenizers::TruncationParams;

use crate::error::{ReinError, Result};

use super::settings;

/// 本地模型的标识，写进 kb_vectors.model_id。换模型必须换这个字符串，
/// 否则旧向量会被当成新模型的向量复用，检索结果会静默错乱。
pub const LOCAL_MODEL_ID: &str = "bge-small-zh-v1.5-int8";
/// bge-small-zh-v1.5 的输出维度。
pub const LOCAL_DIM: usize = 512;
const MAX_LEN: usize = 512;
/// 后台索引的 ORT 线程数。实测 2 线程已拿到约 1.8 倍收益，再往上边际很小，
/// 而核心应留给 UI——索引是后台任务，不该抢前台 CPU。
const INTRA_THREADS: usize = 2;

const MODEL_BYTES: &[u8] =
    include_bytes!("../../../resources/models/bge-small-zh-v1.5/model_quantized.onnx");
const TOKENIZER_BYTES: &[u8] =
    include_bytes!("../../../resources/models/bge-small-zh-v1.5/tokenizer.json");

/* ---------- 运行库供给 ---------- */

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const ORT_LIB_BYTES: &[u8] = include_bytes!("../../../resources/ort/win-x64/onnxruntime.dll");
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const ORT_LIB_BYTES: &[u8] = include_bytes!("../../../resources/ort/win-arm64/onnxruntime.dll");

/// Android / 非 Windows 平台不用内嵌运行库：Android 从 jniLibs 按名字加载，
/// Linux 从系统路径加载。此时 `ORT_LIB_BYTES` 为空，`ensure_ort` 走按名加载分支。
#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "aarch64")
)))]
const ORT_LIB_BYTES: &[u8] = &[];

/// ORT 环境是进程全局的，只能初始化一次，且必须在任何其他 ort API 之前。
static ORT_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

fn ensure_ort(data_dir: &Path) -> Result<()> {
    let r = ORT_INIT.get_or_init(|| {
        let path = if ORT_LIB_BYTES.is_empty() {
            PathBuf::from(if cfg!(target_os = "android") {
                // 由 APK 的 native lib 目录提供，加载器按名字查找
                "libonnxruntime.so"
            } else {
                "libonnxruntime.so"
            })
        } else {
            match extract_ort_lib(data_dir) {
                Ok(p) => p,
                Err(e) => return Err(e),
            }
        };
        ort::init_from(&path)
            .map_err(|e| format!("加载 ONNX Runtime 失败（{}）：{e}", path.display()))?
            .commit();
        Ok(())
    });

    match r {
        Ok(()) => Ok(()),
        Err(e) => Err(ReinError::Message(e.clone())),
    }
}

/// 把内嵌的运行库落到应用数据目录再加载。落盘前比对体积，避免了每次启动都写 15 MB。
fn extract_ort_lib(data_dir: &Path) -> std::result::Result<PathBuf, String> {
    let name = if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else {
        "libonnxruntime.so"
    };
    let dir = data_dir.join("ort");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    let target = dir.join(name);

    let up_to_date = std::fs::metadata(&target)
        .map(|m| m.len() == ORT_LIB_BYTES.len() as u64)
        .unwrap_or(false);
    if !up_to_date {
        // 先写临时文件再改名：中断不会留下半截文件被误判为完整
        let tmp = dir.join(format!("{name}.part"));
        std::fs::write(&tmp, ORT_LIB_BYTES).map_err(|e| format!("写入运行库失败：{e}"))?;
        std::fs::rename(&tmp, &target).map_err(|e| format!("就位运行库失败：{e}"))?;
    }
    Ok(target)
}

/* ---------- 接口 ---------- */

pub trait Embedder: Send + Sync {
    /// 向量模型标识，落库到 kb_vectors.model_id。
    fn model_id(&self) -> &str;
    fn dim(&self) -> usize;
    /// 批量嵌入，返回顺序与入参一致、且已做 L2 归一化的向量。
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;

    /// 连通性/可用性自检：嵌一句话并校验维度。
    fn probe(&self) -> Result<usize> {
        let v = self.embed(&["膝盖".to_string()])?;
        let first = v
            .first()
            .ok_or_else(|| ReinError::Message("嵌入返回空结果".into()))?;
        if first.len() != self.dim() {
            return Err(ReinError::Message(format!(
                "嵌入维度不符：期望 {}，实际 {}",
                self.dim(),
                first.len()
            )));
        }
        Ok(first.len())
    }
}

/// L2 归一化。归一化后余弦相似度退化成点积，检索时省一半计算。
pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-12 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/* ---------- 本地 ORT ---------- */

pub struct LocalEmbedder {
    /// `Session::run` 需要 `&mut`，而 trait 方法只有 `&self`，所以用 Mutex 包一层。
    /// 索引线程是单线程消费，实际不会有争用。
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    input_names: Vec<String>,
}

impl LocalEmbedder {
    pub fn new(data_dir: &Path) -> Result<Self> {
        ensure_ort(data_dir)?;

        let mut tokenizer = Tokenizer::from_bytes(TOKENIZER_BYTES)
            .map_err(|e| ReinError::Message(format!("加载分词器失败：{e}")))?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_LEN,
                ..Default::default()
            }))
            .map_err(|e| ReinError::Message(format!("配置分词截断失败：{e}")))?;

        let session = Session::builder()
            .map_err(|e| ReinError::Message(format!("创建嵌入会话失败：{e}")))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| ReinError::Message(format!("配置图优化失败：{e}")))?
            .with_intra_threads(INTRA_THREADS)
            .map_err(|e| ReinError::Message(format!("配置线程数失败：{e}")))?
            .commit_from_memory(MODEL_BYTES)
            .map_err(|e| ReinError::Message(format!("加载嵌入模型失败：{e}")))?;

        let input_names = session
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .collect();
        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            input_names,
        })
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for text in texts {
            out.push(self.embed_one(text)?);
        }
        Ok(out)
    }

    fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| ReinError::Message(format!("分词失败：{e}")))?;
        let seq = enc.get_ids().len();
        if seq == 0 {
            return Ok(vec![0.0; LOCAL_DIM]);
        }
        let shape = vec![1i64, seq as i64];
        let ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let tti: Vec<i64> = enc.get_type_ids().iter().map(|&x| x as i64).collect();

        // 按模型声明的输入名逐个喂，避免硬编码 BERT 三件套踩到导出差异
        let mut named: Vec<(String, Tensor<i64>)> = Vec::with_capacity(self.input_names.len());
        for name in &self.input_names {
            let data = match name.as_str() {
                "input_ids" => ids.clone(),
                "attention_mask" => mask.clone(),
                "token_type_ids" => tti.clone(),
                other => {
                    return Err(ReinError::Message(format!(
                        "嵌入模型有未预期的输入：{other}"
                    )))
                }
            };
            named.push((
                name.clone(),
                Tensor::from_array((shape.clone(), data))
                    .map_err(|e| ReinError::Message(format!("构造输入张量失败：{e}")))?,
            ));
        }

        let mut session = self
            .session
            .lock()
            .map_err(|_| ReinError::Message("嵌入会话已损坏".into()))?;
        let outputs = session
            .run(named)
            .map_err(|e| ReinError::Message(format!("嵌入推理失败：{e}")))?;

        let tensor = outputs
            .get("last_hidden_state")
            .or_else(|| outputs.get("sentence_embedding"))
            .ok_or_else(|| ReinError::Message("嵌入模型输出里没有 last_hidden_state".into()))?;
        let (shape, data) = tensor
            .try_extract_tensor::<f32>()
            .map_err(|e| ReinError::Message(format!("读取嵌入输出失败：{e}")))?;

        // BGE 池化：last_hidden_state 的首 token（CLS）
        let dim = *shape.last().unwrap_or(&0) as usize;
        let mut v = data[0..dim.min(data.len())].to_vec();
        v.resize(LOCAL_DIM, 0.0);
        normalize(&mut v);
        Ok(v)
    }
}

impl Embedder for LocalEmbedder {
    fn model_id(&self) -> &str {
        LOCAL_MODEL_ID
    }
    fn dim(&self) -> usize {
        LOCAL_DIM
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed_batch(texts)
    }
}

/* ---------- 云端 ---------- */

pub struct CloudEmbedder {
    endpoint: String,
    api_key: String,
    model: String,
    dim: usize,
}

impl CloudEmbedder {
    /// `base_url` 形如 `https://api.example.com/v1`（与 ai_models 的约定一致），
    /// 这里补上 `/embeddings`。
    pub fn new(base_url: &str, api_key: &str, model: &str, dim: Option<i64>) -> Self {
        let base = base_url.trim_end_matches('/');
        Self {
            endpoint: format!("{base}/embeddings"),
            api_key: api_key.to_string(),
            model: model.to_string(),
            // 维度未知时先按 1024 占位，首次嵌入会用实际长度纠正
            dim: dim.filter(|d| *d > 0).map(|d| d as usize).unwrap_or(1024),
        }
    }

    fn call(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let body = serde_json::json!({ "model": self.model, "input": texts });
        let resp = ureq::post(&self.endpoint)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .timeout(std::time::Duration::from_secs(30))
            .send_string(&body.to_string())
            .map_err(|e| ReinError::Message(format!("云端嵌入请求失败：{e}")))?;

        let text = resp
            .into_string()
            .map_err(|e| ReinError::Message(format!("云端嵌入响应读取失败：{e}")))?;
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| ReinError::Message(format!("云端嵌入响应不是 JSON：{e}")))?;

        let arr = json
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ReinError::Message("云端嵌入响应缺少 data 字段".into()))?;

        // 有些实现不保证顺序，按 index 归位
        let mut items: Vec<(usize, Vec<f32>)> = Vec::with_capacity(arr.len());
        for (i, item) in arr.iter().enumerate() {
            let idx = item
                .get("index")
                .and_then(|v| v.as_u64())
                .unwrap_or(i as u64) as usize;
            let vec = item
                .get("embedding")
                .and_then(|v| v.as_array())
                .ok_or_else(|| ReinError::Message("云端嵌入条目缺少 embedding".into()))?
                .iter()
                .map(|x| x.as_f64().unwrap_or(0.0) as f32)
                .collect::<Vec<f32>>();
            items.push((idx, vec));
        }
        items.sort_by_key(|(i, _)| *i);

        let mut out: Vec<Vec<f32>> = items.into_iter().map(|(_, v)| v).collect();
        if out.len() != texts.len() {
            return Err(ReinError::Message(format!(
                "云端嵌入返回条数不符：期望 {}，实际 {}",
                texts.len(),
                out.len()
            )));
        }
        for v in out.iter_mut() {
            normalize(v);
        }
        Ok(out)
    }
}

impl Embedder for CloudEmbedder {
    fn model_id(&self) -> &str {
        &self.model
    }
    fn dim(&self) -> usize {
        self.dim
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        // 云端按批发送：一次 32 条，兼顾延迟与请求体大小
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(32) {
            out.extend(self.call(chunk)?);
        }
        Ok(out)
    }
}

/* ---------- 装配 ---------- */

/// 解析后的嵌入配置。刻意与数据库连接解耦：构建 embedder 会加载模型（实测 130 ms），
/// 必须能在**不持数据库锁**的情况下进行，否则首次检索会把界面卡住。
#[derive(Debug, Clone)]
pub struct EmbedConfig {
    pub mode: String,
    /// (base_url, api_key, model, dim)
    pub cloud: Option<(String, String, String, Option<i64>)>,
}

/// 读一次配置。调用方在持锁期间只做这一步，随后放锁再调 `build`。
pub fn resolve_config(conn: &rusqlite::Connection) -> Result<EmbedConfig> {
    let mode = settings::get(conn)?.embedding_mode;
    let cloud = if mode == crate::modules::kb::models::MODE_CLOUD {
        settings::cloud_config(conn)?
    } else {
        None
    };
    Ok(EmbedConfig { mode, cloud })
}

/// 从配置直接推出向量模型标识，**不需要真的构建 embedder**。
/// 索引线程靠它在持锁阶段就知道该给哪些块算向量，而把真正耗时的构建放到放锁之后。
pub fn model_id_of(cfg: &EmbedConfig) -> Option<String> {
    match cfg.mode.as_str() {
        crate::modules::kb::models::MODE_LOCAL => Some(LOCAL_MODEL_ID.to_string()),
        crate::modules::kb::models::MODE_CLOUD => cfg.cloud.as_ref().map(|(_, _, m, _)| m.clone()),
        _ => None,
    }
}

/// 按配置构造 embedder。`keyword` 模式返回 None——调用方据此跳过向量召回。
pub fn build(cfg: &EmbedConfig, data_dir: &Path) -> Result<Option<Box<dyn Embedder>>> {
    match cfg.mode.as_str() {
        crate::modules::kb::models::MODE_LOCAL => Ok(Some(Box::new(LocalEmbedder::new(data_dir)?))),
        crate::modules::kb::models::MODE_CLOUD => match &cfg.cloud {
            Some((url, key, model, dim)) => {
                Ok(Some(Box::new(CloudEmbedder::new(url, key, model, *dim))))
            }
            None => Err(ReinError::Message(
                "云端嵌入尚未配置完整（需要 base URL、API Key、模型名）".into(),
            )),
        },
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_makes_unit_vector() {
        let mut v = vec![3.0f32, 4.0];
        normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_survives_zero_vector() {
        let mut v = vec![0.0f32, 0.0];
        normalize(&mut v);
        assert_eq!(v, vec![0.0, 0.0], "零向量不能除出 NaN");
    }

    #[test]
    fn cloud_endpoint_is_composed_from_base_url() {
        let e = CloudEmbedder::new("https://api.example.com/v1/", "k", "m", Some(512));
        assert_eq!(e.endpoint, "https://api.example.com/v1/embeddings");
        assert_eq!(e.dim(), 512);
    }

    /// 本地模型是编进二进制的，所以「模型文件存在」这件事由编译期保证。
    /// 这里只验证运行库按平台选对了供给方式。
    #[test]
    fn ort_lib_supply_matches_platform() {
        if cfg!(target_os = "windows")
            && (cfg!(target_arch = "x86_64") || cfg!(target_arch = "aarch64"))
        {
            assert!(!ORT_LIB_BYTES.is_empty(), "Windows 应内嵌运行库");
        } else {
            assert!(ORT_LIB_BYTES.is_empty(), "非 Windows 平台不应内嵌运行库");
        }
    }

    #[test]
    fn model_bytes_look_like_onnx() {
        // ONNX 是 protobuf，但模型的第一个字节不固定；校验体积足够大以免误配空文件
        assert!(
            MODEL_BYTES.len() > 1_000_000,
            "模型体积异常：{}",
            MODEL_BYTES.len()
        );
        assert!(TOKENIZER_BYTES.len() > 1000, "分词器体积异常");
        let head = String::from_utf8_lossy(&TOKENIZER_BYTES[..64.min(TOKENIZER_BYTES.len())]);
        assert!(head.contains('{'), "分词器应是 JSON");
    }

    /// 真实加载 ONNX 模型做一次推理。这条是本地嵌入式接口唯一的实证：
    /// 它同时覆盖 ORT 动态加载、运行库落盘、模型加载、分词、池化与归一化。
    #[test]
    fn local_embedder_loads_model_and_separates_domains() {
        let dir = std::env::temp_dir().join("rein-kb-embed-selftest");
        let e = LocalEmbedder::new(&dir).expect("本地嵌入器应能加载模型");
        assert_eq!(e.dim(), LOCAL_DIM);
        assert_eq!(e.model_id(), LOCAL_MODEL_ID);

        let texts: Vec<String> = ["深蹲", "腿部力量训练", "晚餐吃了什么"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let v = e.embed(&texts).expect("推理应成功");
        assert_eq!(v.len(), 3);
        for x in &v {
            assert_eq!(x.len(), LOCAL_DIM);
            let norm = x.iter().map(|a| a * a).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-3, "应已 L2 归一化，实际 {norm}");
        }

        let cos = |a: &Vec<f32>, b: &Vec<f32>| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let near = cos(&v[0], &v[1]);
        let far = cos(&v[0], &v[2]);
        assert!(
            near > far + 0.1,
            "同域（深蹲↔腿部训练 {near:.3}）应明显高于跨域（深蹲↔晚餐 {far:.3}）"
        );

        // probe 是给 UI 做「测试连接」用的，必须能独立跑通
        assert_eq!(e.probe().unwrap(), LOCAL_DIM);
    }
}
