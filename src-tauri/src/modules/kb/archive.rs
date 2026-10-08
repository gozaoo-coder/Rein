//! 压缩包：**打开**（列内容）与**解压进工作区**（zip / tar / tar.gz / 单文件 gzip）。
//!
//! 设计取舍：
//! - **格式按魔数识别，不看扩展名**：用户上传的文件常常是 `application/octet-stream`，
//!   前端也未必传 mime；扩展名可以被随便改，而魔数不会骗人。识别不了就直说支持哪些。
//! - **解压产物进虚拟工作区**，不落物理目录：文本文件成为 text 节点（进索引、可检索、
//!   AI 能用 read_knowledge 读），二进制成为多模态节点（本体落 workspace/media/，
//!   走模态层按需取）。压缩包内的目录层级保留到深度上限，更深的拍平。
//! - **一切写入按「不覆盖」处理**：同名节点走 free_path / 目录让位，绝不覆盖既有文件。
//! - **护栏是硬要求**（可能在解压用户从网上拿来的包）：zip-slip / 绝对路径 / 符号链接
//!   一律跳过；条目数、单文件与总量、压缩比都有上限，超限即拒绝而不是把设备撑爆。

use std::io::Read;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::{ReinError, Result};

use super::models::{FILE_KIND_FOLDER, FILE_KIND_TEXT, INBOX_ROOT};
use super::source::sanitize;
use super::{assets, files, index};

/* ---------- 上限 ---------- */

/// 列清单最多回多少条（更大的包只回前 N 条 + truncated）。
pub const LIST_CAP: usize = 500;
/// 单次解压最多落多少个文件。
pub const MAX_FILES: usize = 300;
/// 解压后总字节上限（防 zip bomb 把磁盘写满）。
pub const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// 单文件上限（超过的条目跳过并记原因，而不是整包失败）。
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// 压缩比闸门：解压后超过 `RATIO_FLOOR` 且比值超过 `RATIO_MAX` 视为可疑，拒绝整包。
const RATIO_MAX: u64 = 200;
const RATIO_FLOOR: u64 = 64 * 1024 * 1024;
/// 直接当文本入库的字节上限（更大的文本也走二进制本体，避免一次写进数据库）。
const MAX_TEXT_BYTES: u64 = 512 * 1024;
/// 解压产物的目录深度上限（相对落点，与治理层 MAX_DEPTH 同口径）。
const MAX_INNER_DEPTH: usize = 3;
/// gzip 解压的**输出**上限。解压在内存里做：没有上限时，一个几十 KB 的炸弹包
/// 在「条目体积护栏」生效之前就能把进程撑爆。取值是落盘预算的两倍——真包够用，
/// 炸弹在这里就被挡住（顺带把 tar.gz 的压缩比判据也放回生效范围）。
const GUNZIP_CAP: u64 = MAX_TOTAL_BYTES * 2;
/// 列表里提示的条数上限：一个满是 `../` 的包能生成上万条提示，
/// 而它们最终会进模型上下文。
const NOTES_MAX: usize = 10;

/// 免解压就能当文本读的扩展名（大小写不敏感）。
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html",
    "htm", "log", "ini", "conf", "toml", "srt", "vtt", "js", "ts", "py", "rs", "go", "java", "c",
    "h", "cpp", "sh", "sql", "css",
];

/* ---------- 类型 ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zip,
    Tar,
    TarGz,
    Gzip,
    Unknown,
}

impl Format {
    pub fn as_str(&self) -> &'static str {
        match self {
            Format::Zip => "zip",
            Format::Tar => "tar",
            Format::TarGz => "tar.gz",
            Format::Gzip => "gzip",
            Format::Unknown => "unknown",
        }
    }
}

/// 一个条目的元信息（列表页与解压计划共用）。
#[derive(Debug, Clone)]
pub struct Entry {
    /// 压缩包内的原始路径（已过路径净化）
    pub name: String,
    pub size: u64,
    pub packed: u64,
    pub is_dir: bool,
    /// 是否按文本节点入库
    pub as_text: bool,
    /// 跳过的原因（Some 时不会解压）
    pub skip: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbArchiveEntry {
    pub path: String,
    pub size: i64,
    pub packed: i64,
    pub is_dir: bool,
    /// 是否会被当作可检索文本入库
    pub text: bool,
    pub skipped: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbArchiveListing {
    pub format: String,
    pub entries: Vec<KbArchiveEntry>,
    /// 包内条目总数（可能大于 entries.len()）
    pub total: i64,
    /// 解压后总字节（原始，未截断）
    pub total_bytes: i64,
    pub packed_bytes: i64,
    pub truncated: bool,
    /// 提示与告警（可疑路径、超限条目等）
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbArchiveItem {
    pub id: i64,
    pub path: String,
    pub bytes: i64,
    /// text | binary
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbArchiveReport {
    pub format: String,
    /// 落点目录（虚拟路径）
    pub target: String,
    pub extracted: Vec<KbArchiveItem>,
    pub skipped: Vec<String>,
    pub bytes: i64,
    pub truncated: bool,
    pub message: String,
}

/* ---------- 识别与解析 ---------- */

/// 按魔数识别格式（`name` 只用于区分 tar 与 tar.gz 之外的同族歧义，不做主判据）。
pub fn detect(bytes: &[u8], name: &str) -> Format {
    if bytes.len() >= 4 && &bytes[..4] == b"PK\x03\x04" {
        return Format::Zip;
    }
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        // gzip：里面可能是 tar（.tar.gz）也可能是单文件
        if let Ok(raw) = gunzip(bytes) {
            if is_tar(&raw) {
                return Format::TarGz;
            }
        }
        return Format::Gzip;
    }
    if is_tar(bytes) {
        return Format::Tar;
    }
    // 空 zip（22 字节 EOCD 开头）也应认出来
    if bytes.len() >= 4 && &bytes[..4] == b"PK\x05\x06" {
        return Format::Zip;
    }
    let _ = name;
    Format::Unknown
}

fn is_tar(bytes: &[u8]) -> bool {
    bytes.len() > 262 && &bytes[257..262] == b"ustar"
}

pub fn unsupported_message(name: &str) -> String {
    format!(
        "「{name}」的格式暂不支持解压（只认 zip / tar / tar.gz / 单文件 gz；\
         rar / 7z / xz 等请先在电脑上转成 zip）。"
    )
}

/// gzip 解压（带输出上限，见 [`GUNZIP_CAP`]）。
fn gunzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut dec = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes)).take(GUNZIP_CAP + 1);
    dec.read_to_end(&mut out)
        .map_err(|e| ReinError::Message(format!("gzip 解压失败（文件可能损坏）：{e}")))?;
    if out.len() as u64 > GUNZIP_CAP {
        return Err(ReinError::Message(format!(
            "gzip 解压后超过 {} MB 上限：包太大或压缩比异常（疑似压缩炸弹），出于安全考虑拒绝。\
             请先在电脑上拆包再传入。",
            GUNZIP_CAP / 1048576
        )));
    }
    Ok(out)
}

/// 记一条提示；超过 [`NOTES_MAX`] 的只计数，最后并成一条。
/// 返回 1 表示这条被压掉（调用方累加后写汇总）。
fn note(notes: &mut Vec<String>, msg: String) -> usize {
    if notes.len() < NOTES_MAX {
        notes.push(msg);
        0
    } else {
        1
    }
}

/// tar / tar.gz 的条目没有各自的压缩体积：按解压后体积**等比分摊**整包体积。
///
/// 两个作用：(1) 压缩比闸门对 tar.gz 也生效——原来 `packed` 全是 0，判据因
/// `packed_bytes > 0` 不成立被整段跳过，而 tar.gz 恰恰是等比压缩、最该拦的一类；
/// (2) 列表里的「压缩包 X MB」不再是 0。
fn attribute_packed(entries: &mut [Entry], packed_total: u64) {
    let raw_total: u64 = entries.iter().map(|e| e.size).sum();
    if raw_total == 0 || packed_total == 0 {
        return;
    }
    for e in entries.iter_mut() {
        e.packed = (e.size as u128 * packed_total as u128 / raw_total as u128) as u64;
    }
}

/// 压缩比闸门：解压后总量超过 [`RATIO_FLOOR`] 且比值超过 [`RATIO_MAX`] → 拒绝整包。
///
/// **列清单与解压两条路径都要过**（解压不再经过 `list`，别让这里成为缺口）。
fn check_ratio(entries: &[Entry], packed_total: u64) -> Result<()> {
    let total: u64 = entries.iter().map(|e| e.size).sum();
    if total > RATIO_FLOOR && packed_total > 0 && total / packed_total.max(1) > RATIO_MAX {
        return Err(ReinError::Message(format!(
            "压缩比异常（解压后约 {} MB，压缩包仅 {} KB），出于安全考虑拒绝解压",
            total / 1048576,
            packed_total / 1024
        )));
    }
    Ok(())
}

/// 路径净化：去掉绝对路径与前导 `./`，拒绝 `..` 与盘符，逐段 sanitize。
/// 返回 None = 该条目路径不安全（zip-slip），跳过。
fn clean_path(raw: &str) -> Option<String> {
    let raw = raw.replace('\\', "/");
    if raw.starts_with('/') || raw.starts_with('~') {
        return None;
    }
    // Windows 盘符（C:\ 已在上面的反斜杠替换里变成 C:/）
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        return None;
    }
    let mut segs: Vec<String> = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        let s = sanitize(seg, 60);
        if s.is_empty() || s == "." || s == ".." {
            continue;
        }
        segs.push(s);
    }
    if segs.is_empty() {
        return None;
    }
    Some(segs.join("/"))
}

fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

fn text_extension(name: &str) -> bool {
    TEXT_EXTS.contains(&ext_of(name).as_str())
}

/// 条目是否值得当文本读：扩展名像文本 + 体积在闸门内 + 没有 NUL 字节。
fn looks_text(name: &str, size: u64, sample: &[u8]) -> bool {
    text_extension(name) && size <= MAX_TEXT_BYTES && !sample.contains(&0u8)
}

/// zip 的 unix 权限位里是否为符号链接（解压符号链接是经典逃逸手法，直接跳过）。
fn zip_is_symlink(mode: Option<u32>) -> bool {
    matches!(mode, Some(m) if m & 0o170000 == 0o120000)
}

/// 列出包内条目（zip / tar / tar.gz / gzip）。只读元信息，不解压全部内容。
pub fn list(bytes: &[u8], name: &str) -> Result<KbArchiveListing> {
    let format = detect(bytes, name);
    let mut entries: Vec<Entry> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut unsafe_count = 0usize;
    let mut suppressed = 0usize;

    match format {
        Format::Zip => {
            let mut ar = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|e| ReinError::Message(format!("打开 zip 失败（文件可能损坏）：{e}")))?;
            for i in 0..ar.len() {
                let f = ar
                    .by_index(i)
                    .map_err(|e| ReinError::Message(format!("读取 zip 条目失败：{e}")))?;
                let raw = f.name().to_string();
                let size = f.size();
                let packed = f.compressed_size();
                let is_dir = f.is_dir();
                let symlink = zip_is_symlink(f.unix_mode());
                let sample = if !is_dir && size > 0 && size <= 4096 {
                    // 小文件直接取头部判文本；大文件交给扩展名判断
                    let f = f;
                    let mut buf = Vec::new();
                    let _ = f.take(4096).read_to_end(&mut buf);
                    buf
                } else {
                    Vec::new()
                };
                match clean_path(&raw) {
                    None => {
                        unsafe_count += 1;
                        suppressed += note(&mut notes, format!("跳过可疑路径：{raw}"));
                    }
                    Some(clean) => {
                        let skip = if symlink {
                            Some("符号链接不落盘".to_string())
                        } else if size > MAX_FILE_BYTES {
                            Some(format!("单文件超过上限（{} MB）", MAX_FILE_BYTES / 1048576))
                        } else {
                            None
                        };
                        let as_text = !is_dir
                            && skip.is_none()
                            && looks_text(&clean, size, &sample);
                        entries.push(Entry {
                            name: clean,
                            size,
                            packed,
                            is_dir,
                            as_text,
                            skip,
                        });
                    }
                }
            }
        }
        Format::Tar => {
            parse_tar(bytes, &mut entries, &mut notes, &mut unsafe_count)?;
            attribute_packed(&mut entries, bytes.len() as u64);
        }
        Format::TarGz => {
            let raw = gunzip(bytes)?;
            parse_tar(&raw, &mut entries, &mut notes, &mut unsafe_count)?;
            attribute_packed(&mut entries, bytes.len() as u64);
        }
        Format::Gzip => {
            // 单文件 gz：解出来就是一个文件，名字取去掉 .gz 的部分
            let raw = gunzip(bytes)?;
            let stem = name
                .rsplit('/')
                .next()
                .unwrap_or("解压文件")
                .trim_end_matches(".gz")
                .trim_end_matches(".GZ");
            let stem = if stem.is_empty() { "解压文件" } else { stem };
            let clean = sanitize(stem, 60);
            let sample: &[u8] = &raw[..raw.len().min(4096)];
            entries.push(Entry {
                name: clean.clone(),
                size: raw.len() as u64,
                packed: bytes.len() as u64,
                is_dir: false,
                as_text: looks_text(&clean, raw.len() as u64, sample),
                skip: None,
            });
        }
        Format::Unknown => {
            return Err(ReinError::Message(unsupported_message(name)));
        }
    }

    let total_bytes: u64 = entries.iter().map(|e| e.size).sum();
    let packed_bytes: u64 = entries.iter().map(|e| e.packed).sum();
    check_ratio(&entries, packed_bytes)?;

    let truncated = entries.len() > LIST_CAP;
    let shown: Vec<KbArchiveEntry> = entries
        .iter()
        .take(LIST_CAP)
        .map(|e| KbArchiveEntry {
            path: e.name.clone(),
            size: e.size as i64,
            packed: e.packed as i64,
            is_dir: e.is_dir,
            text: e.as_text,
            skipped: e.skip.clone(),
        })
        .collect();
    if truncated {
        notes.push(format!(
            "条目较多，只显示前 {LIST_CAP} 条（共 {} 条）",
            entries.len()
        ));
    }
    if unsafe_count > 0 {
        notes.push(format!(
            "{unsafe_count} 个条目带不安全路径（绝对路径 / .. / 盘符），已跳过"
        ));
    }
    if suppressed > 0 {
        notes.push(format!("另有 {suppressed} 条同类提示已省略"));
    }

    Ok(KbArchiveListing {
        format: format.as_str().to_string(),
        entries: shown,
        total: entries.len() as i64,
        total_bytes: total_bytes as i64,
        packed_bytes: packed_bytes as i64,
        truncated,
        notes,
    })
}

fn parse_tar(
    raw: &[u8],
    entries: &mut Vec<Entry>,
    notes: &mut Vec<String>,
    unsafe_count: &mut usize,
) -> Result<()> {
    let mut ar = tar::Archive::new(std::io::Cursor::new(raw));
    let iter = ar
        .entries()
        .map_err(|e| ReinError::Message(format!("打开 tar 失败：{e}")))?;
    let mut suppressed = 0usize;
    for item in iter {
        let e = match item {
            Ok(e) => e,
            Err(err) => {
                suppressed += note(notes, format!("有条目无法读取，已跳过：{err}"));
                continue;
            }
        };
        let header = e.header().clone();
        let raw_name = String::from_utf8_lossy(&header.path_bytes()).to_string();
        let size = header.size().unwrap_or(0);
        let etype = header.entry_type();
        if !etype.is_file() && !etype.is_dir() {
            *unsafe_count += 1;
            suppressed += note(notes, format!("跳过非普通文件条目：{raw_name}"));
            continue;
        }
        let is_dir = etype.is_dir();
        let mut sample = Vec::new();
        if !is_dir && size > 0 && size <= 4096 {
            let _ = e.take(4096).read_to_end(&mut sample);
        }
        match clean_path(&raw_name) {
            None => {
                *unsafe_count += 1;
                suppressed += note(notes, format!("跳过可疑路径：{raw_name}"));
            }
            Some(clean) => {
                let skip = if size > MAX_FILE_BYTES {
                    Some(format!("单文件超过上限（{} MB）", MAX_FILE_BYTES / 1048576))
                } else {
                    None
                };
                let as_text =
                    !is_dir && skip.is_none() && looks_text(&clean, size, &sample);
                entries.push(Entry {
                    name: clean,
                    size,
                    packed: 0,
                    is_dir,
                    as_text,
                    skip,
                });
            }
        }
    }
    if suppressed > 0 {
        notes.push(format!("另有 {suppressed} 条同类提示已省略"));
    }
    Ok(())
}

/* ---------- 解压落库 ---------- */

#[derive(Debug, Clone, Default)]
pub struct ExtractOptions {
    /// 落点目录（虚拟路径）。缺省 = `未分类数据/解压/{包名}`。
    pub to_dir: Option<String>,
    /// 只解压路径里包含这些子串的条目（空 = 全解）。
    pub only: Vec<String>,
}

/// 目录让位：目标目录已被占用（有同名节点或已含子路径）时追加 `-2`、`-3`。
fn free_dir(conn: &Connection, path: &str) -> Result<String> {
    for i in 0..64 {
        let cand = if i == 0 {
            path.to_string()
        } else {
            format!("{path}-{}", i + 1)
        };
        let occupied: i64 = conn.query_row(
            "SELECT COUNT(*) FROM kb_files WHERE path = ?1 OR path LIKE ?2",
            rusqlite::params![cand, format!("{cand}/%")],
            |r| r.get(0),
        )?;
        if occupied == 0 {
            return Ok(cand);
        }
    }
    Err(ReinError::Message(format!("找不到可用目录名：{path}")))
}

/// 解压产物在落点目录内的自由路径（同名就 `-v2`……）。
///
/// 不走 `governance::free_path`：那个还带派生文档保留区的让位语义，
/// 而解压落点是我们自己刚建的新目录，只需要「不覆盖同名文件」这一条。
fn free_child_path(conn: &Connection, dir: &str, inner: &str) -> Result<String> {
    let base = inner.rsplit('/').next().unwrap_or(inner);
    let prefix = inner[..inner.len() - base.len()].trim_end_matches('/');
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (base.to_string(), String::new()),
    };
    for i in 0..64 {
        let name = if i == 0 {
            base.to_string()
        } else {
            format!("{stem}-v{}{ext}", i + 1)
        };
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let path = format!("{dir}/{rel}");
        let taken: i64 = conn.query_row(
            "SELECT COUNT(*) FROM kb_files WHERE path = ?1",
            [&path],
            |r| r.get(0),
        )?;
        if taken == 0 {
            return Ok(path);
        }
    }
    Err(ReinError::Message(format!("{dir}/ 下同名文件过多：{inner}")))
}

/// 落点目录归位：已知根目录直通，裸路径落收件箱，逐段 sanitize。
fn normalize_target_dir(raw: &str) -> Result<String> {
    let raw = raw.trim().trim_matches('/');
    let mut segs: Vec<String> = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(ReinError::Message(format!("路径不允许包含 ..：{raw}")));
        }
        let s = sanitize(seg, 60);
        if !s.is_empty() {
            segs.push(s);
        }
    }
    if segs.is_empty() {
        return Err(ReinError::Message("落点目录不能为空".into()));
    }
    let first = segs[0].as_str();
    let known = super::models::WRITABLE_ROOTS.contains(&first)
        || super::models::DOMAIN_ROOTS.contains(&first);
    if !known {
        segs.insert(0, INBOX_ROOT.to_string());
    }
    Ok(segs.join("/"))
}

/// 把压缩包解压进工作区。文本进 text 节点（可检索），二进制进多模态节点（本体落盘）。
pub fn extract(
    conn: &Connection,
    root: &Path,
    bytes: &[u8],
    name: &str,
    opts: &ExtractOptions,
) -> Result<KbArchiveReport> {
    // 落点目录：显式给了就用，否则 未分类数据/解压/{包名}
    let target_raw = match opts.to_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => normalize_target_dir(dir)?,
        None => {
            let stem = name
                .rsplit('/')
                .next()
                .unwrap_or("压缩包")
                .rsplit_once('.')
                .map(|(s, _)| s)
                .unwrap_or("压缩包");
            format!("{INBOX_ROOT}/解压/{}", sanitize(stem, 40))
        }
    };
    let target = free_dir(conn, &target_raw)?;

    // 全量条目 + 已解开的包体（list 只回前 500 条，解压要按全量判断）
    let mut plan = plan_entries(bytes, name, &opts.only)?;
    let format = plan.format.as_str().to_string();
    // 内容读取器：每类包只解析一次（见 [`ContentReader`]）
    let mut reader = ContentReader::new(bytes, name, plan.format, plan.inflated.take())?;

    let mut extracted: Vec<KbArchiveItem> = Vec::new();
    let mut skipped: Vec<String> = std::mem::take(&mut plan.notes);
    let mut written_bytes: u64 = 0;
    let mut truncated = false;

    // 整段解压走一个事务：300 个文件 = 数百次插入 + 数百次 mark_dirty，
    // 不开事务时每条语句各自提交（各写一次 WAL）；中途失败还会把工作区
    // 留在「解了一半」的状态。
    let tx = conn.unchecked_transaction()?;

    // 目录节点（空目录也要可见）
    files::write_media_row(&tx, &target, &format!("【目录】{target}"), FILE_KIND_FOLDER)?;

    let mut budget_hit = false;
    for e in &plan.entries {
        if e.is_dir {
            let dir_path = format!("{target}/{}", e.name);
            files::write_media_row(
                &tx,
                &dir_path,
                &format!("【目录】{dir_path}"),
                FILE_KIND_FOLDER,
            )?;
            continue;
        }
        if let Some(reason) = &e.skip {
            skipped.push(format!("{}（{reason}）", e.name));
            continue;
        }
        if extracted.len() >= MAX_FILES {
            truncated = true;
            skipped.push(format!("条目超过 {MAX_FILES} 个，其余未解压"));
            break;
        }
        if written_bytes >= MAX_TOTAL_BYTES || budget_hit {
            truncated = true;
            skipped.push("解压总量超过上限，其余未解压".to_string());
            break;
        }

        let Some(data) = reader.read(&e.name)? else {
            skipped.push(format!("{}（读不到内容）", e.name));
            continue;
        };
        // 压缩比/总量护栏：单条也可能把预算顶爆
        let remaining = MAX_TOTAL_BYTES.saturating_sub(written_bytes);
        if data.len() as u64 > remaining {
            truncated = true;
            skipped.push(format!("{}（超出剩余空间预算）", e.name));
            budget_hit = true;
            continue;
        }

        let inner = cap_inner_path(&e.name);
        let rel_name = e.name.rsplit('/').next().unwrap_or(&e.name).to_string();
        let bytes_len = data.len() as u64;
        if e.as_text {
            let path = free_child_path(&tx, &target, &inner)?;
            let text = String::from_utf8_lossy(&data).to_string();
            let content = if text.trim().is_empty() {
                format!("（{rel_name}：空文件）")
            } else {
                text
            };
            let fid = files::write_media_row(&tx, &path, &content, FILE_KIND_TEXT)?;
            index::mark_dirty(&tx, "note", &fid.to_string())?;
            extracted.push(KbArchiveItem {
                id: fid,
                path,
                bytes: bytes_len as i64,
                kind: "text".into(),
            });
        } else {
            let path = free_child_path(&tx, &target, &inner)?;
            let mime = assets::mime_of_name(&rel_name);
            let fid = assets::write_media_bytes(
                &tx,
                root,
                &path,
                &rel_name,
                &mime,
                &data,
                &format!("【解压自 {name}】{rel_name}"),
            )?;
            index::mark_dirty(&tx, "note", &fid.to_string())?;
            extracted.push(KbArchiveItem {
                id: fid,
                path,
                bytes: bytes_len as i64,
                kind: "binary".into(),
            });
        }
        written_bytes += bytes_len;
    }
    tx.commit()?;

    let text_count = extracted.iter().filter(|i| i.kind == "text").count();
    let bin_count = extracted.len() - text_count;
    let message = format!(
        "已解压到 {target}/：{} 个文件（{} 个文本已进检索，{} 个本体落盘），共 {}",
        extracted.len(),
        text_count,
        bin_count,
        human_size(written_bytes)
    );

    Ok(KbArchiveReport {
        format,
        target,
        extracted,
        skipped,
        bytes: written_bytes as i64,
        truncated,
        message,
    })
}

/// 解压计划：全量条目 + 已解开的包体（tar.gz / 单文件 gz 在计划阶段就解开一次，
/// 解压阶段直接复用，不再重复 gunzip）。
struct Plan {
    format: Format,
    entries: Vec<Entry>,
    notes: Vec<String>,
    inflated: Option<Vec<u8>>,
}

/// 解压计划：把 list 的结果扩到全量条目（list 只回前 500 条）。
fn plan_entries(bytes: &[u8], name: &str, only: &[String]) -> Result<Plan> {
    let mut entries = Vec::new();
    let mut notes = Vec::new();
    let mut unsafe_count = 0usize;
    let mut inflated: Option<Vec<u8>> = None;
    let format = detect(bytes, name);
    match format {
        Format::Zip => {
            let mut ar = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|e| ReinError::Message(format!("打开 zip 失败（文件可能损坏）：{e}")))?;
            for i in 0..ar.len() {
                let f = ar
                    .by_index(i)
                    .map_err(|e| ReinError::Message(format!("读取 zip 条目失败：{e}")))?;
                let raw = f.name().to_string();
                let size = f.size();
                let is_dir = f.is_dir();
                let symlink = zip_is_symlink(f.unix_mode());
                let sample = if !is_dir && size > 0 && size <= 4096 {
                    let f = f;
                    let mut buf = Vec::new();
                    let _ = f.take(4096).read_to_end(&mut buf);
                    buf
                } else {
                    Vec::new()
                };
                if let Some(clean) = clean_path(&raw) {
                    let skip = if symlink {
                        Some("符号链接不落盘".to_string())
                    } else if size > MAX_FILE_BYTES {
                        Some(format!("单文件超过上限（{} MB）", MAX_FILE_BYTES / 1048576))
                    } else {
                        None
                    };
                    let as_text =
                        !is_dir && skip.is_none() && looks_text(&clean, size, &sample);
                    entries.push(Entry {
                        name: clean,
                        size,
                        packed: 0,
                        is_dir,
                        as_text,
                        skip,
                    });
                } else {
                    unsafe_count += 1;
                }
            }
        }
        Format::Tar => parse_tar(bytes, &mut entries, &mut notes, &mut unsafe_count)?,
        Format::TarGz => {
            let raw = gunzip(bytes)?;
            parse_tar(&raw, &mut entries, &mut notes, &mut unsafe_count)?;
            inflated = Some(raw);
        }
        Format::Gzip => {
            let raw = gunzip(bytes)?;
            let clean = sanitize(&gz_stem(name), 60);
            let sample: &[u8] = &raw[..raw.len().min(4096)];
            entries.push(Entry {
                name: clean.clone(),
                size: raw.len() as u64,
                packed: bytes.len() as u64,
                is_dir: false,
                as_text: looks_text(&clean, raw.len() as u64, sample),
                skip: None,
            });
            inflated = Some(raw);
        }
        Format::Unknown => return Err(ReinError::Message(unsupported_message(name))),
    }
    let _ = unsafe_count;

    // 与 list 同一条压缩比闸门：解压不再经过 list，这里漏掉就是缺口
    if matches!(format, Format::Tar | Format::TarGz) {
        attribute_packed(&mut entries, bytes.len() as u64);
    }
    check_ratio(&entries, entries.iter().map(|e| e.packed).sum())?;

    let entries = if only.is_empty() {
        entries
    } else {
        entries
            .into_iter()
            .filter(|e| only.iter().any(|pat| e.name.contains(pat.as_str())))
            .collect()
    };
    Ok(Plan {
        format,
        entries,
        notes,
        inflated,
    })
}

/// 单文件 gzip 的名字：去掉路径与 `.gz`。
fn gz_stem(name: &str) -> String {
    let stem = name
        .rsplit('/')
        .next()
        .unwrap_or("解压文件")
        .trim_end_matches(".gz")
        .trim_end_matches(".GZ");
    if stem.is_empty() {
        "解压文件".to_string()
    } else {
        stem.to_string()
    }
}

/// 解压时的按需取内容器：**每类包只解析一次**。
///
/// 老实现是「每个条目重新打开一次包」——zip 每条目重扫一遍中央目录逐个比名字，
/// tar.gz 每条目把整包 gunzip 一遍（300 个文件 ≈ 300 次全量解压，几十 GB 的解压量）。
/// 现在构造时建一次「净化名 → 位置」索引，取内容都是 O(1)。
enum Store<'a> {
    Zip(
        zip::ZipArchive<std::io::Cursor<&'a [u8]>>,
        std::collections::HashMap<String, usize>,
    ),
    /// 解开的 tar 字节 + 名字 →（数据偏移, 长度）
    Tar(
        std::borrow::Cow<'a, [u8]>,
        std::collections::HashMap<String, (usize, u64)>,
    ),
    /// 单文件 gz：净化名 + 解开的内容
    Single(String, std::borrow::Cow<'a, [u8]>),
}

struct ContentReader<'a> {
    store: Store<'a>,
}

impl<'a> ContentReader<'a> {
    fn new(bytes: &'a [u8], name: &str, format: Format, inflated: Option<Vec<u8>>) -> Result<Self> {
        let inflated: Option<std::borrow::Cow<'a, [u8]>> = inflated.map(std::borrow::Cow::Owned);
        let store = match format {
            Format::Zip => {
                let mut ar = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                    .map_err(|e| ReinError::Message(format!("打开 zip 失败：{e}")))?;
                let mut index = std::collections::HashMap::new();
                for i in 0..ar.len() {
                    let f = ar
                        .by_index(i)
                        .map_err(|e| ReinError::Message(format!("读取 zip 条目失败：{e}")))?;
                    if f.is_dir() {
                        continue;
                    }
                    if let Some(clean) = clean_path(f.name()) {
                        index.entry(clean).or_insert(i);
                    }
                }
                Store::Zip(ar, index)
            }
            Format::Tar | Format::TarGz => {
                let raw = inflated.unwrap_or(std::borrow::Cow::Borrowed(bytes));
                let mut index = std::collections::HashMap::new();
                let mut ar = tar::Archive::new(std::io::Cursor::new(&raw[..]));
                if let Ok(iter) = ar.entries() {
                    for e in iter.flatten() {
                        let header = e.header().clone();
                        if !header.entry_type().is_file() {
                            continue;
                        }
                        let raw_name = String::from_utf8_lossy(&header.path_bytes()).to_string();
                        if let Some(clean) = clean_path(&raw_name) {
                            let size = header.size().unwrap_or(0);
                            index
                                .entry(clean)
                                .or_insert((e.raw_file_position() as usize, size));
                        }
                    }
                }
                Store::Tar(raw, index)
            }
            Format::Gzip => {
                let clean = sanitize(&gz_stem(name), 60);
                let raw = inflated.unwrap_or(std::borrow::Cow::Borrowed(bytes));
                Store::Single(clean, raw)
            }
            Format::Unknown => Store::Single(String::new(), std::borrow::Cow::Borrowed(&[][..])),
        };
        Ok(Self { store })
    }

    /// 取一个条目的完整内容（上限 [`MAX_FILE_BYTES`]）。
    fn read(&mut self, want: &str) -> Result<Option<Vec<u8>>> {
        match &mut self.store {
            Store::Zip(ar, index) => {
                let Some(&i) = index.get(want) else {
                    return Ok(None);
                };
                let f = ar
                    .by_index(i)
                    .map_err(|e| ReinError::Message(format!("读取 zip 条目失败：{e}")))?;
                let mut buf = Vec::new();
                f.take(MAX_FILE_BYTES)
                    .read_to_end(&mut buf)
                    .map_err(|e| ReinError::Message(format!("读取 {want} 失败：{e}")))?;
                Ok(Some(buf))
            }
            Store::Tar(raw, index) => {
                let Some(&(off, size)) = index.get(want) else {
                    return Ok(None);
                };
                if off >= raw.len() {
                    return Ok(None);
                }
                let end = raw.len().min(off.saturating_add(size.min(MAX_FILE_BYTES) as usize));
                Ok(Some(raw[off..end].to_vec()))
            }
            Store::Single(clean, raw) => {
                if clean == want {
                    Ok(Some(raw.to_vec()))
                } else {
                    Ok(None)
                }
            }
        }
    }
}

/// 包内路径截断到深度上限（第 4 层及以后拍平成文件名）。
fn cap_inner_path(inner: &str) -> String {
    let segs: Vec<&str> = inner.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() <= MAX_INNER_DEPTH {
        return segs.join("/");
    }
    let head = segs[..MAX_INNER_DEPTH - 1].join("/");
    let tail = segs[MAX_INNER_DEPTH - 1..].join("-");
    format!("{head}/{tail}")
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    /// 最小可用的 zip 打包器（deflate 存储法用 Stored，省掉压缩后端差异）
    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn detects_formats_by_magic_not_extension() {
        let z = zip_bytes(&[("a.txt", b"hi")]);
        assert_eq!(detect(&z, "改过名的.dat"), Format::Zip);
        assert_eq!(detect(&[0u8; 8], "x.zip"), Format::Unknown);
        // tar
        let mut tar_buf = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_buf);
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            b.append_data(&mut header, "b.txt", &b"hello"[..]).unwrap();
            b.finish().unwrap();
        }
        assert_eq!(detect(&tar_buf, "b.tar"), Format::Tar);
        // tar.gz
        use flate2::write::GzEncoder;
        use std::io::Write as _;
        let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar_buf).unwrap();
        let tgz = gz.finish().unwrap();
        assert_eq!(detect(&tgz, "b.tar.gz"), Format::TarGz);
        // 单文件 gz
        let mut gz2 = GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz2.write_all(b"just text").unwrap();
        let single = gz2.finish().unwrap();
        assert_eq!(detect(&single, "a.txt.gz"), Format::Gzip);
    }

    #[test]
    fn list_reports_entries_sizes_and_text_flag() {
        let z = zip_bytes(&[
            ("docs/readme.md", b"# hello"),
            ("bin/blob.dat", &[0u8, 1, 2, 3]),
            ("docs/", b""),
        ]);
        let l = list(&z, "包.zip").unwrap();
        assert_eq!(l.format, "zip");
        assert_eq!(l.total, 3);
        let md = l.entries.iter().find(|e| e.path == "docs/readme.md").unwrap();
        assert!(md.text, "md 应按文本入库");
        let blob = l.entries.iter().find(|e| e.path == "bin/blob.dat").unwrap();
        assert!(!blob.text, "二进制不该按文本入库");
        let dir = l.entries.iter().find(|e| e.is_dir).unwrap();
        assert_eq!(dir.path, "docs");
    }

    #[test]
    fn zip_slip_and_absolute_paths_are_skipped() {
        let z = zip_bytes(&[
            ("../evil.sh", b"rm -rf /"),
            ("/etc/passwd", b"root"),
            ("C:/windows/x", b"x"),
            ("ok.txt", b"fine"),
        ]);
        let l = list(&z, "包.zip").unwrap();
        assert_eq!(l.total, 1, "只有 ok.txt 该留下");
        assert_eq!(l.entries[0].path, "ok.txt");
        assert!(l.notes.iter().any(|n| n.contains("可疑路径")));
    }

    #[test]
    fn extract_writes_text_and_binary_into_workspace() {
        let conn = db();
        let root = std::env::temp_dir().join("rein-kb-archive-test");
        let _ = std::fs::create_dir_all(&root);
        let z = zip_bytes(&[
            ("a/note.md", "# 内容".as_bytes()),
            ("a/data.bin", &[9u8, 8, 7]),
        ]);
        let r = extract(&conn, &root, &z, "资料.zip", &ExtractOptions::default()).unwrap();
        assert!(r.target.starts_with(INBOX_ROOT), "默认落收件箱：{}", r.target);
        assert_eq!(r.extracted.len(), 2);
        let text = r.extracted.iter().find(|i| i.kind == "text").unwrap();
        assert!(text.path.ends_with("note.md"));
        let bin = r.extracted.iter().find(|i| i.kind == "binary").unwrap();
        assert!(bin.path.ends_with("data.bin"));
        // 文本节点的正文真的进了 kb_files，能被检索层派生
        let content: String = conn
            .query_row("SELECT content FROM kb_files WHERE id = ?1", [text.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(content.contains("内容"));
        // 二进制本体真的落盘了
        let refs = assets::fs_refs(&conn, bin.id).unwrap();
        assert_eq!(refs.len(), 1);
        assert!(root.join(&refs[0]).exists(), "本体应在磁盘上");
    }

    #[test]
    fn extract_can_filter_entries_and_avoids_overwriting() {
        let conn = db();
        let root = std::env::temp_dir().join("rein-kb-archive-test-2");
        let _ = std::fs::create_dir_all(&root);
        let z = zip_bytes(&[("x/one.md", b"1"), ("y/two.md", b"2")]);
        let opts = ExtractOptions {
            to_dir: Some("笔记/解压测试".into()),
            only: vec!["one".into()],
        };
        let r = extract(&conn, &root, &z, "t.zip", &opts).unwrap();
        assert_eq!(r.extracted.len(), 1);
        assert!(r.target == "笔记/解压测试");
        // 再解一次同名的包：目录自动让位，不覆盖
        let r2 = extract(&conn, &root, &z, "t.zip", &opts).unwrap();
        assert_ne!(r2.target, r.target, "第二个同名目录应让位");
    }

    #[test]
    fn unsupported_format_tells_what_is_supported() {
        let e = list(b"not an archive", "a.7z").unwrap_err().to_string();
        assert!(e.contains("zip"), "{e}");
    }

    #[test]
    fn cap_inner_path_flattens_deep_trees() {
        assert_eq!(cap_inner_path("a/b/c"), "a/b/c");
        assert_eq!(cap_inner_path("a/b/c/d/e.txt"), "a/b/c-d-e.txt");
    }

    /// 造一个高压缩比的 tar.gz（全零 → 比值远超闸门）。
    fn tar_gz_bomb(zeros: usize) -> Vec<u8> {
        let big = vec![0u8; zeros];
        let mut tar_buf = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_buf);
            let mut header = tar::Header::new_gnu();
            header.set_size(big.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            b.append_data(&mut header, "zeros.bin", &big[..]).unwrap();
            b.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &tar_buf).unwrap();
        gz.finish().unwrap()
    }

    /// tar.gz 的高压缩比包**在列表与解压两条路径上都要被拦**：
    /// 原来 tar 系列的 packed 全是 0，判据因 `packed_bytes > 0` 不成立被整段跳过。
    #[test]
    fn tar_gz_ratio_guard_covers_list_and_extract() {
        let tgz = tar_gz_bomb(66 * 1024 * 1024);
        assert!(
            tgz.len() * 200 < 66 * 1024 * 1024,
            "构造的包必须能触发比值判据，实际 {} 字节",
            tgz.len()
        );
        let listed = list(&tgz, "bomb.tar.gz").unwrap_err().to_string();
        assert!(listed.contains("压缩比异常"), "列表要拦：{listed}");

        let conn = db();
        let root = std::env::temp_dir().join("rein-kb-archive-bomb");
        let _ = std::fs::create_dir_all(&root);
        let extracted = extract(
            &conn,
            &root,
            &tgz,
            "bomb.tar.gz",
            &ExtractOptions::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            extracted.contains("压缩比异常"),
            "解压也要拦（解压不再经过 list，别在这里漏）：{extracted}"
        );
    }

    /// 正常 tar.gz：文本与二进制都要按偏移索引取对字节。
    #[test]
    fn tar_gz_extracts_text_and_binary() {
        let blob = [0u8, 1, 2, 3, 4, 5, 6, 7];
        let mut tar_buf = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_buf);
            let mut h1 = tar::Header::new_gnu();
            h1.set_size(6);
            h1.set_mode(0o644);
            h1.set_cksum();
            b.append_data(&mut h1, "docs/a.md", &b"# hi\n\n"[..]).unwrap();
            let mut h2 = tar::Header::new_gnu();
            h2.set_size(blob.len() as u64);
            h2.set_mode(0o644);
            h2.set_cksum();
            b.append_data(&mut h2, "bin/x.bin", &blob[..]).unwrap();
            b.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &tar_buf).unwrap();
        let tgz = gz.finish().unwrap();

        let conn = db();
        let root = std::env::temp_dir().join("rein-kb-archive-tgz");
        let _ = std::fs::create_dir_all(&root);
        let r = extract(&conn, &root, &tgz, "资料.tar.gz", &ExtractOptions::default()).unwrap();
        assert_eq!(r.extracted.len(), 2);
        let text = r.extracted.iter().find(|i| i.kind == "text").unwrap();
        let content: String = conn
            .query_row("SELECT content FROM kb_files WHERE id = ?1", [text.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(content.contains("# hi"), "文本内容要从索引取对：{content}");
        let bin = r.extracted.iter().find(|i| i.kind == "binary").unwrap();
        let refs = assets::fs_refs(&conn, bin.id).unwrap();
        let on_disk = std::fs::read(root.join(&refs[0])).unwrap();
        assert_eq!(on_disk, blob.to_vec(), "二进制字节要精确（偏移索引不能错位）");
    }

    /// 提示条数封顶：一个满是可疑路径的包不该刷出上万条提示（它们会进模型上下文）。
    #[test]
    fn unsafe_path_notes_are_capped() {
        let names: Vec<String> = (0..30).map(|i| format!("../evil{i}.sh")).collect();
        let mut files: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"x"[..])).collect();
        files.push(("ok.txt", b"fine"));
        let z = zip_bytes(&files);

        let l = list(&z, "包.zip").unwrap();
        assert_eq!(l.total, 1);
        assert!(
            l.notes.len() <= NOTES_MAX + 2,
            "提示条数应封顶，实际 {}：{:?}",
            l.notes.len(),
            l.notes
        );
        assert!(l.notes.iter().any(|n| n.contains("已省略")), "{:?}", l.notes);
    }
}
