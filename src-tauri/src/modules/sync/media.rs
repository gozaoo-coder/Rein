//! 大字段的抽取与还原：列值 ↔ blob 引用。
//!
//! 四种形态（见 `tables::Media`），三种是"一列一个值"，一种是"JSON 列里散着若干个值"：
//!
//! | 形态 | 列上长什么样 | 抽出来的字节 |
//! |---|---|---|
//! | `Base64` | 纯 base64 文本（聊天图 `image_base64`） | base64 解码后的原图 |
//! | `DataUrl` | `data:<mime>;base64,xxx` 或一个文件路径（知识库 `ref`） | 解码后的字节 / 文件内容 |
//! | `JsonMedia` | JSON 字符串，值里散着 `data:` 与 `base64` 字段 | 每个值各存一个 blob |
//! | `Wav` | 落盘音频的路径（语音纪要） | 文件内容 |
//!
//! 还原是**按 marker 自描述**做的：marker 里带 `enc`，所以还原不需要再猜规则，
//! 也不会因为将来新增一种形态而把老数据解错。
//!
//! JSON 列的规则是**确定的、不猜的**：只有「字符串以 `data:` 开头」与「键名恰好是
//! `base64`」两类会被抽走。别的长字符串一律原样带着 —— 宁可多占几 KB，也不要
//! 因为一条启发式规则把正文当成图片搬走。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{Map, Value};

use crate::error::Result;

use super::blobs::BlobStore;
use super::tables::Media;

/// 只抽超过这个长度的值：短字符串不可能是真图片，抽走反而多一次读写。
const MIN_MEDIA_LEN: usize = 128;

/// 列值 → blob 引用。`Ok(None)` = 这个值不需要抽（原样带着）。
pub fn encode(store: &BlobStore, kind: Media, conn: &rusqlite::Connection, value: &str) -> Result<Option<Value>> {
    match kind {
        Media::Base64 => {
            if value.len() < MIN_MEDIA_LEN {
                return Ok(None);
            }
            match B64.decode(value.trim()) {
                Ok(bytes) if bytes.len() >= MIN_MEDIA_LEN => {
                    let hash = store.put(conn, &bytes)?;
                    Ok(Some(marker(&hash, bytes.len() as i64, "b64", None)))
                }
                _ => Ok(None),
            }
        }
        Media::DataUrl => {
            if let Some((mime, bytes)) = split_data_url(value) {
                let hash = store.put(conn, &bytes)?;
                return Ok(Some(marker(&hash, bytes.len() as i64, "dataurl", Some(&mime))));
            }
            // 知识库媒体：storage = 'fs' 时 ref 是文件路径
            if value.len() > 3 {
                let path = store.resolve(value);
                if path.is_file() {
                    let bytes = std::fs::read(&path)?;
                    let hash = store.put(conn, &bytes)?;
                    let name = path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| hash.clone());
                    return Ok(Some(marker(&hash, bytes.len() as i64, "file", Some(&name))));
                }
            }
            Ok(None)
        }
        Media::Wav => {
            let path = store.resolve(value);
            if !path.is_file() {
                return Ok(None);
            }
            let bytes = std::fs::read(&path)?;
            let hash = store.put(conn, &bytes)?;
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("{hash}.wav"));
            Ok(Some(marker(&hash, bytes.len() as i64, "wav", Some(&name))))
        }
        Media::JsonMedia => {
            let mut parsed: Value = match serde_json::from_str(value) {
                Ok(v) => v,
                // 不是 JSON 就原样带着（历史数据里有纯文本）
                Err(_) => return Ok(None),
            };
            let mut changed = false;
            walk_encode(store, conn, &mut parsed, &mut changed)?;
            if !changed {
                return Ok(None);
            }
            Ok(Some(serde_json::json!({
                "__json": serde_json::to_string(&parsed)?,
                "enc": "json",
            })))
        }
    }
}

/// marker 里带来的 name、对象 uuid 这类**对端可控**的字符串要当文件名成分用之前，
/// 先过这道白名单：拒绝路径分隔符、盘符、`..` 与控制字符 —— 失陷的对端设备不能借
/// 落地路径把文件写出工作区。合法值（uuid、中文文件名、`photo.jpg`）都原样通过。
fn safe_component(s: &str) -> Option<&str> {
    if s.is_empty() || s == "." || s == ".." {
        return None;
    }
    if s.contains(['/', '\\', ':']) {
        return None;
    }
    if s.chars().any(char::is_control) {
        return None;
    }
    Some(s)
}

/// blob 引用 → 列值（还原成前端读到的原始形态）。
pub fn decode(store: &BlobStore, conn: &rusqlite::Connection, row_id: &str, marker: &Value) -> Result<String> {
    let enc = marker.get("enc").and_then(|v| v.as_str()).unwrap_or("");
    match enc {
        "json" => {
            let text = marker
                .get("__json")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut parsed: Value = serde_json::from_str(text)?;
            walk_decode(store, conn, row_id, &mut parsed)?;
            Ok(serde_json::to_string(&parsed)?)
        }
        "b64" => {
            let bytes = bytes_of(store, marker)?;
            Ok(B64.encode(bytes))
        }
        // 超大文本列（通用闸门挂上来的）：原样还原成字符串
        "text" => {
            let bytes = bytes_of(store, marker)?;
            Ok(String::from_utf8_lossy(&bytes).to_string())
        }
        "dataurl" => {
            let bytes = bytes_of(store, marker)?;
            let mime = marker.get("mime").and_then(|v| v.as_str()).unwrap_or("application/octet-stream");
            Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
        }
        "file" => {
            // 落回 `workspace/media/<hash 前两位>/<文件名>`：内容寻址，同一份字节不重复落
            let bytes = bytes_of(store, marker)?;
            let hash = super::blobs::marker_field(marker, "__blob")?;
            // name 是对端可控的：不老实就退回内容寻址名，宁可名字难看也不能写出目录
            let name = marker
                .get("name")
                .and_then(|v| v.as_str())
                .and_then(safe_component)
                .unwrap_or(hash);
            let dir = store.data_dir().join("workspace").join("media").join(&hash[..2.min(hash.len())]);
            std::fs::create_dir_all(&dir)?;
            let path = dir.join(name);
            if !path.is_file() {
                std::fs::write(&path, &bytes)?;
            }
            Ok(store.relativize(&path))
        }
        "wav" => {
            // 音频必须落在 voice_sessions/ 下：素材协议的白名单就是那个目录
            let bytes = bytes_of(store, marker)?;
            let base = safe_component(row_id).ok_or_else(|| {
                let preview: String = row_id.chars().take(16).collect();
                crate::error::ReinError::Message(format!("语音对象 id 不合法：{preview}"))
            })?;
            let dir = store.data_dir().join("voice_sessions");
            std::fs::create_dir_all(&dir)?;
            let path = dir.join(format!("{base}.wav"));
            if !path.is_file() {
                std::fs::write(&path, &bytes)?;
            }
            Ok(store.relativize(&path))
        }
        other => Err(crate::error::ReinError::Message(format!(
            "未知的 blob 形态：{other}"
        ))),
    }
}

/// 这个值是不是 blob 引用（应用对象时按它分流）。
pub fn is_marker(v: &Value) -> bool {
    v.get("__blob").is_some() || v.get("enc").and_then(|e| e.as_str()) == Some("json")
}

fn bytes_of(store: &BlobStore, marker: &Value) -> Result<Vec<u8>> {
    let hash = super::blobs::marker_field(marker, "__blob")?;
    store
        .get(hash)?
        .ok_or_else(|| crate::error::ReinError::Message(format!("blob 缺失：{hash}")))
}

fn marker(hash: &str, bytes: i64, enc: &str, extra: Option<&str>) -> Value {
    let mut map = Map::new();
    map.insert("__blob".into(), Value::String(hash.to_string()));
    map.insert("bytes".into(), Value::from(bytes));
    map.insert("enc".into(), Value::String(enc.to_string()));
    if let Some(v) = extra {
        let key = if enc == "dataurl" { "mime" } else { "name" };
        map.insert(key.into(), Value::String(v.to_string()));
    }
    Value::Object(map)
}

/// `data:<mime>;base64,<payload>` → (mime, bytes)
fn split_data_url(value: &str) -> Option<(String, Vec<u8>)> {
    let rest = value.strip_prefix("data:")?;
    let (head, payload) = rest.split_once(',')?;
    if !head.ends_with(";base64") || payload.len() < MIN_MEDIA_LEN {
        return None;
    }
    let mime = head.trim_end_matches(";base64").to_string();
    let bytes = B64.decode(payload.trim()).ok()?;
    Some((mime, bytes))
}

fn walk_encode(
    store: &BlobStore,
    conn: &rusqlite::Connection,
    value: &mut Value,
    changed: &mut bool,
) -> Result<()> {
    match value {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if key == "base64" {
                    if let Value::String(s) = val {
                        if s.len() >= MIN_MEDIA_LEN {
                            if let Some(m) = encode(store, Media::Base64, conn, s)? {
                                *val = m;
                                *changed = true;
                                continue;
                            }
                        }
                    }
                }
                walk_encode(store, conn, val, changed)?;
            }
        }
        Value::Array(items) => {
            for it in items.iter_mut() {
                walk_encode(store, conn, it, changed)?;
            }
        }
        Value::String(s) => {
            if s.starts_with("data:") && s.len() >= MIN_MEDIA_LEN {
                if let Some(m) = encode(store, Media::DataUrl, conn, s)? {
                    *value = m;
                    *changed = true;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn walk_decode(
    store: &BlobStore,
    conn: &rusqlite::Connection,
    row_id: &str,
    value: &mut Value,
) -> Result<()> {
    // 先判 marker 再展开：marker 自己也是个对象，混在一起会同时借可变与不可变
    if is_marker(value) {
        let restored = decode(store, conn, row_id, &value.clone())?;
        *value = Value::String(restored);
        return Ok(());
    }
    match value {
        Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                walk_decode(store, conn, row_id, val)?;
            }
        }
        Value::Array(items) => {
            for it in items.iter_mut() {
                walk_decode(store, conn, row_id, it)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;
    use rusqlite::Connection;

    fn setup() -> (Connection, BlobStore, tempdir::TempDir) {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        let dir = tempdir::TempDir::new();
        let store = BlobStore::new(dir.path());
        (conn, store, dir)
    }

    /// 本地临时目录（不想为测试引 tempfile 依赖，自己写一个十行的）
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct TempDir(PathBuf);

        impl TempDir {
            pub fn new() -> Self {
                let mut p = std::env::temp_dir();
                p.push(format!("rein-sync-test-{}", std::process::id()));
                p.push(format!("{}", rand::random::<u32>()));
                std::fs::create_dir_all(&p).unwrap();
                Self(p)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn base64_round_trip() {
        let (conn, store, _dir) = setup();
        let raw = vec![7u8; 4096];
        let encoded = B64.encode(&raw);
        let m = encode(&store, Media::Base64, &conn, &encoded).unwrap().unwrap();
        assert_eq!(m["enc"], "b64");
        assert!(m["bytes"].as_i64().unwrap() >= 4096);
        let back = decode(&store, &conn, "x", &m).unwrap();
        assert_eq!(back, encoded);
    }

    #[test]
    fn short_values_are_left_alone() {
        let (conn, store, _dir) = setup();
        assert!(encode(&store, Media::Base64, &conn, "abcd").unwrap().is_none());
        assert!(encode(&store, Media::DataUrl, &conn, "data:image/png;base64,AA")
            .unwrap()
            .is_none());
    }

    #[test]
    fn data_url_round_trip_keeps_mime() {
        let (conn, store, _dir) = setup();
        let payload = vec![3u8; 2048];
        let url = format!("data:image/jpeg;base64,{}", B64.encode(&payload));
        let m = encode(&store, Media::DataUrl, &conn, &url).unwrap().unwrap();
        assert_eq!(m["mime"], "image/jpeg");
        assert_eq!(decode(&store, &conn, "x", &m).unwrap(), url);
    }

    #[test]
    fn json_media_extracts_only_known_shapes() {
        let (conn, store, _dir) = setup();
        let img = B64.encode(vec![9u8; 1024]);
        let src = serde_json::json!({
            "text": "正文里的长字符串不动，即便它看起来很长很长很长很长很长很长很长很长很长很长",
            "resultImage": { "base64": img, "mime": "image/png" },
            "thumb": format!("data:image/png;base64,{}", B64.encode(vec![1u8; 512])),
        })
        .to_string();
        let m = encode(&store, Media::JsonMedia, &conn, &src).unwrap().unwrap();
        let text = m["__json"].as_str().unwrap();
        assert!(text.contains("__blob"), "两个大值都该被抽走");
        assert!(!text.contains("\"base64\":\"iYm"), "base64 不该留在对象里");
        let back = decode(&store, &conn, "x", &m).unwrap();
        let parsed: Value = serde_json::from_str(&back).unwrap();
        assert_eq!(parsed["resultImage"]["base64"].as_str().unwrap(), img);
        assert!(parsed["thumb"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(parsed["text"].as_str().unwrap().contains("正文里的长字符串"));
    }

    #[test]
    fn wav_round_trip_lands_in_voice_sessions() {
        let (conn, store, _dir) = setup();
        let src = store.data_dir().join("voice_sessions");
        std::fs::create_dir_all(&src).unwrap();
        let wav = src.join("memo-1.wav");
        std::fs::write(&wav, vec![5u8; 4096]).unwrap();
        let m = encode(&store, Media::Wav, &conn, &store.relativize(&wav))
            .unwrap()
            .unwrap();
        std::fs::remove_file(&wav).unwrap();
        let back = decode(&store, &conn, "memo-1", &m).unwrap();
        assert!(back.ends_with("voice_sessions/memo-1.wav") || back.ends_with("voice_sessions\\memo-1.wav"));
        assert_eq!(std::fs::read(store.resolve(&back)).unwrap(), vec![5u8; 4096]);
    }

    #[test]
    fn identical_bytes_share_one_blob() {
        let (conn, store, _dir) = setup();
        let payload = B64.encode(vec![2u8; 900]);
        let a = encode(&store, Media::Base64, &conn, &payload).unwrap().unwrap();
        let b = encode(&store, Media::Base64, &conn, &payload).unwrap().unwrap();
        assert_eq!(a["__blob"], b["__blob"]);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_blobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
