//! blob 库：内容寻址（sha256），同一份字节只存一次。
//!
//! 为什么需要它：聊天里的图片是 base64 塞在 SQLite 列里的、语音纪要是落盘的 wav、
//! 知识库媒体是 `workspace/media` 下的文件 —— 「全量同步」必须把这些字节也搬过去，
//! 但**不能**塞进对象里：一个 5 MB 的 base64 会让单条对象变得没法在帧层分片，
//! 也让「中继只走小对象」这条预算失效。所以大字段一律抽成 blob：
//! 对象里只留 `{ "__blob": "<sha256>", "bytes": N, "enc": ... }`，字节按需传输（接收方驱动）。
//!
//! 落盘布局：`<app_data>/sync_blobs/<hash 前两位>/<hash>` —— 分桶是为了避免单目录塞几千个文件。

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::{ReinError, Result};

pub struct BlobStore {
    root: PathBuf,
    /// 应用数据目录：`kb_assets.ref` 这类相对/绝对路径要靠它解析
    data_dir: PathBuf,
}

impl BlobStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("sync_blobs"),
            data_dir: data_dir.to_path_buf(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn hash_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn path(&self, hash: &str) -> PathBuf {
        let bucket = hash.get(0..2).unwrap_or("00");
        self.root.join(bucket).join(hash)
    }

    pub fn has(&self, hash: &str) -> bool {
        self.path(hash).is_file()
    }

    /// 写入字节并登记目录表（幂等：同一份内容第二次写只更新目录行）。
    pub fn put(&self, conn: &Connection, bytes: &[u8]) -> Result<String> {
        let hash = Self::hash_of(bytes);
        let path = self.path(&hash);
        if !path.is_file() {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            // 先写临时文件再改名：同步线程写入期间被读到的文件必须是完整的
            let tmp = path.with_extension("part");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &path)?;
        }
        conn.execute(
            "INSERT INTO sync_blobs (hash, bytes, created_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes",
            rusqlite::params![hash, bytes.len() as i64, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(hash)
    }

    pub fn get(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        let path = self.path(hash);
        if !path.is_file() {
            return Ok(None);
        }
        Ok(Some(std::fs::read(path)?))
    }

    /// 分块接收：随机写 `.part` 文件（顺序无关，丢块重传也只覆盖那一段）。
    ///
    /// 为什么不能直接写最终路径：`put` 见到文件已存在就跳过（内容寻址的幂等），
    /// 半截文件会让「补齐」永远落不下去 —— 长度对、内容错，且这种错会被摘要掩盖住。
    pub fn write_chunk(&self, hash: &str, off: usize, total: usize, bytes: &[u8]) -> Result<()> {
        let part = self.part_path(hash);
        if let Some(dir) = part.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&part)?;
        // 先按 total 撑到该有的长度，避免乱序时中间出现空洞
        if file.metadata()?.len() < total as u64 {
            file.set_len(total as u64)?;
        }
        use std::io::{Seek, SeekFrom, Write};
        file.seek(SeekFrom::Start(off as u64))?;
        file.write_all(bytes)?;
        file.flush()?;
        Ok(())
    }

    /// 收齐一块 blob：校验 sha256 与前缀给的 hash 一致，再改名就位并登记。
    pub fn finish_chunked(&self, conn: &Connection, hash: &str, total: usize) -> Result<()> {
        let part = self.part_path(hash);
        if !part.is_file() {
            return Err(ReinError::Message(format!("blob {hash} 没有收到任何字节")));
        }
        if part.metadata()?.len() != total as u64 {
            return Err(ReinError::Message(format!(
                "blob {hash} 长度不对：{} != {total}",
                part.metadata()?.len()
            )));
        }
        let mut hasher = Sha256::new();
        {
            use std::io::Read;
            let mut f = std::fs::File::open(&part)?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
        }
        let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if actual != hash {
            let _ = std::fs::remove_file(&part);
            return Err(ReinError::Message(format!(
                "blob 摘要不符（期望 {hash}，实得 {actual}），已丢弃"
            )));
        }
        let path = self.path(hash);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&part, &path)?;
        conn.execute(
            "INSERT INTO sync_blobs (hash, bytes, created_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes",
            rusqlite::params![hash, total as i64, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    pub fn part_path(&self, hash: &str) -> PathBuf {
        self.path(hash).with_extension("part")
    }

    /// 目录表里少一行但文件在（手工拷进来的库）时补登记；文件不在则返回大小 0。
    pub fn size_of(&self, conn: &Connection, hash: &str) -> Result<i64> {
        let known: Option<i64> = conn
            .query_row("SELECT bytes FROM sync_blobs WHERE hash = ?1", [hash], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(n) = known {
            return Ok(n);
        }
        let path = self.path(hash);
        if path.is_file() {
            let n = std::fs::metadata(&path)?.len() as i64;
            conn.execute(
                "INSERT OR REPLACE INTO sync_blobs (hash, bytes, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![hash, n, chrono::Utc::now().timestamp_millis()],
            )?;
            return Ok(n);
        }
        Ok(0)
    }

    /// 把 `kb_assets.ref` 那种路径解析成本机路径（绝对路径原样用，相对路径挂到数据目录下）。
    pub fn resolve(&self, value: &str) -> PathBuf {
        let p = Path::new(value);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.data_dir.join(p)
        }
    }

    /// 相对数据目录的路径（能相对就相对，落库时不写死本机绝对路径）。
    pub fn relativize(&self, path: &Path) -> String {
        match path.strip_prefix(&self.data_dir) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => path.to_string_lossy().replace('\\', "/"),
        }
    }
}

/// 从 marker 里取字段（`{"__blob": ..., "bytes": ...}`），缺字段要吵而不是默认成空。
pub fn marker_field<'a>(marker: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    marker
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| ReinError::Message(format!("blob 引用缺少 {key}")))
}
