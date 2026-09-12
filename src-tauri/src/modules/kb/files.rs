//! 真实文件层（kb_files）：知识库里唯一「内容即真源」的存储。
//!
//! 与派生文档的边界是整个 VFS 的关键（docs/kb-vfs.md §1）：
//! - 派生文档：正文是缓存，改内容必须改源数据，重放会覆盖任何直改；
//! - 真实文件：`kb_files` 就是真源，编辑走这里再标脏，派生管线把它的内容镜像进 kb_docs。
//!
//! 用户文件**只允许落在 `笔记/` 命名空间**，`规范/` 是系统文件（system=1）：可读、
//! 会随应用升级更新内容，但不可编辑、改名、删除——它定义的就是「什么是可编辑」本身。

use rusqlite::{Connection, OptionalExtension};

use crate::error::{ReinError, Result};

use super::index;
use super::models::{KbFile, DOC_ROOT, NOTE_ROOT, SPEC_PATH, SPEC_ROOT};

/// 规范文件内容 = 仓库里的规范文档，单一事实源（改规范只改那一份，两端同时生效）。
const SPEC_MARKDOWN: &str = include_str!("../../../../docs/kb-vfs.md");

const COLS: &str = "id, path, content, system, created_at, updated_at";

fn row_to_file(r: &rusqlite::Row) -> rusqlite::Result<KbFile> {
    Ok(KbFile {
        id: r.get(0)?,
        path: r.get(1)?,
        content: r.get(2)?,
        system: r.get::<_, i64>(3)? != 0,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

/// 把用户给的路径归位成合法的虚拟路径：
/// - 裸路径补 `笔记/` 前缀（用户只写 `膝盖.md` 也会落到 `笔记/膝盖.md`）；
/// - `文档/` 是上传文档全文的命名空间（发送时自动归档），同样可写；
/// - 补 `.md` 后缀；
/// - 每段过 sanitize，拒绝 `..` 之类的目录穿越。
/// 拒绝写进 `规范/`——那是系统命名空间。
pub fn normalize_path(raw: &str) -> Result<String> {
    let raw = raw.trim().trim_start_matches('/');
    if raw.is_empty() {
        return Err(ReinError::Message("文件路径不能为空".into()));
    }
    if raw.split('/').any(|seg| seg == "..") {
        return Err(ReinError::Message(format!(
            "路径不允许包含 ..：{raw}"
        )));
    }
    if raw.starts_with(&format!("{SPEC_ROOT}/")) {
        return Err(ReinError::Message(
            "规范/ 是系统命名空间，只能由应用更新，不能由用户写入".into(),
        ));
    }
    let known = [format!("{NOTE_ROOT}/"), format!("{DOC_ROOT}/")];
    let full = if known.iter().any(|root| raw.starts_with(root.as_str())) {
        raw.to_string()
    } else {
        format!("{NOTE_ROOT}/{raw}")
    };

    let segments: Vec<String> = full
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| super::source::sanitize(s, 60))
        .collect();
    let mut path = segments.join("/");
    if !path.ends_with(".md") {
        path.push_str(".md");
    }
    Ok(path)
}

/// 新建或覆盖一个文件（按 path 幂等）。返回文件 id。
pub fn write(conn: &Connection, raw_path: &str, content: &str) -> Result<i64> {
    let path = normalize_path(raw_path)?;
    if content.trim().is_empty() {
        return Err(ReinError::Message("文件内容不能为空".into()));
    }

    let existing: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE path = ?1", [&path], |r| r.get(0))
        .optional()?;

    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE kb_files SET content = ?2, updated_at = datetime('now') WHERE id = ?1",
                rusqlite::params![id, content],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO kb_files(path, content, system, created_at, updated_at)
                 VALUES (?1, ?2, 0, datetime('now'), datetime('now'))",
                rusqlite::params![path, content],
            )?;
            conn.last_insert_rowid()
        }
    };

    // 内容进了 kb_files 还要进检索编目
    index::mark_dirty(conn, "note", &id.to_string())?;
    Ok(id)
}

/// 改名 / 移动。系统文件拒绝。返回新路径。`id` 可以是文档 id 或文件 id。
pub fn rename(conn: &Connection, id: i64, raw_path: &str) -> Result<String> {
    let id = resolve_file_id(conn, id)?;
    assert_not_system(conn, id, "改名")?;
    let path = normalize_path(raw_path)?;
    let dup: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE path = ?1 AND id <> ?2", rusqlite::params![path, id], |r| r.get(0))
        .optional()?;
    if dup.is_some() {
        return Err(ReinError::Message(format!("目标路径已存在：{path}")));
    }
    conn.execute(
        "UPDATE kb_files SET path = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![id, path],
    )?;
    index::mark_dirty(conn, "note", &id.to_string())?;
    Ok(path)
}

/// 删除文件。系统文件拒绝。`id` 可以是文档 id 或文件 id。
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    let id = resolve_file_id(conn, id)?;
    assert_not_system(conn, id, "删除")?;
    let n = conn.execute("DELETE FROM kb_files WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ReinError::Message(format!("文件不存在：id={id}")));
    }
    // 编目文档一并清掉（显式删块以维护 FTS，见 index.rs 的说明）
    index::delete_doc(conn, "note", &id.to_string())?;
    Ok(())
}

/// 把调用方给的 id 解析成 kb_files.id。统一入口都收**文档 id**（与 glob/检索一致），
/// 但直接传文件 id 也兼容：笔记文档的 source_id 就是文件 id 字符串。
pub fn resolve_file_id(conn: &Connection, id: i64) -> Result<i64> {
    let direct: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    if direct.is_some() {
        return Ok(id);
    }
    let via_doc: Option<String> = conn
        .query_row(
            "SELECT source_id FROM kb_docs WHERE id = ?1 AND source_type = 'note'",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    via_doc
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| ReinError::Message(format!("文件不存在：id={id}（先用 glob_knowledge 查 id）")))
}

pub fn get(conn: &Connection, id: i64) -> Result<KbFile> {
    let fid = resolve_file_id(conn, id)?;
    conn.query_row(
        &format!("SELECT {COLS} FROM kb_files WHERE id = ?1"),
        [fid],
        row_to_file,
    )
    .optional()?
    .ok_or_else(|| ReinError::Message(format!("文件不存在：id={id}")))
}

/// 按路径取（测试与调试用；命令层统一走 id）。
#[cfg(test)]
pub fn get_by_path(conn: &Connection, path: &str) -> Result<Option<KbFile>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM kb_files WHERE path = ?1"),
            [path],
            row_to_file,
        )
        .optional()?)
}

fn assert_not_system(conn: &Connection, id: i64, action: &str) -> Result<()> {
    let system: Option<i64> = conn
        .query_row("SELECT system FROM kb_files WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    match system {
        None => Err(ReinError::Message(format!("文件不存在：id={id}"))),
        Some(s) if s != 0 => Err(ReinError::Message(format!(
            "该文件是系统文件（规范/），不能{action}；它的内容随应用版本更新"
        ))),
        Some(_) => Ok(()),
    }
}

/// 播种规范文件。内容与 docs/kb-vfs.md 同源（include_str!），改动会随升级重放。
/// 幂等：内容没变就什么都不做。
pub fn ensure_spec(conn: &Connection) -> Result<()> {
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, content FROM kb_files WHERE path = ?1",
            [SPEC_PATH],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    match existing {
        Some((_id, content)) if content == SPEC_MARKDOWN => Ok(()),
        Some((id, _)) => {
            conn.execute(
                "UPDATE kb_files SET content = ?2, updated_at = datetime('now') WHERE id = ?1",
                rusqlite::params![id, SPEC_MARKDOWN],
            )?;
            index::mark_dirty(conn, "note", &id.to_string())
        }
        None => {
            conn.execute(
                "INSERT INTO kb_files(path, content, system, created_at, updated_at)
                 VALUES (?1, ?2, 1, datetime('now'), datetime('now'))",
                [SPEC_PATH, SPEC_MARKDOWN],
            )?;
            index::mark_dirty(conn, "note", &conn.last_insert_rowid().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::index;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn paths_are_normalized_into_note_root() {
        assert_eq!(normalize_path("膝盖.md").unwrap(), "笔记/膝盖.md");
        assert_eq!(normalize_path("膝盖").unwrap(), "笔记/膝盖.md");
        assert_eq!(normalize_path("训练/深蹲.md").unwrap(), "笔记/训练/深蹲.md");
        assert_eq!(normalize_path("/笔记/a.md").unwrap(), "笔记/a.md");
    }

    #[test]
    fn doc_root_is_writable_for_uploaded_documents() {
        assert_eq!(
            normalize_path("文档/军事技能训练安排表9-10.md").unwrap(),
            "文档/军事技能训练安排表9-10.md"
        );
        // 也能通过 files::write 落库并编目
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let id = write(&conn, "文档/安排表.md", "第9周 周三 队列训练").unwrap();
        let f = get(&conn, id).unwrap();
        assert_eq!(f.path, "文档/安排表.md");
        assert!(!f.system);
    }

    #[test]
    fn paths_reject_escape_and_spec_root() {
        assert!(normalize_path("../系统.md").is_err(), "目录穿越必须被拒");
        assert!(normalize_path("a/../../b.md").is_err());
        assert!(normalize_path("规范/伪造.md").is_err(), "系统命名空间不可写");
        assert!(normalize_path("  ").is_err());
    }

    #[test]
    fn path_segments_are_sanitized() {
        // 文件名里的非法字符与分隔符必须被净化
        // 斜杠是分段符（保留），段内非法字符净化
        assert_eq!(normalize_path("膝盖/深蹲*问号?.md").unwrap(), "笔记/膝盖/深蹲-问号-.md");
        assert_eq!(normalize_path("a<b>c|d.md").unwrap(), "笔记/a-b-c-d.md");
    }

    #[test]
    fn write_is_upsert_by_path() {
        let conn = db();
        let a = write(&conn, "膝盖.md", "避免深蹲").unwrap();
        let b = write(&conn, "膝盖.md", "避免深蹲超过 60kg").unwrap();
        assert_eq!(a, b, "同路径应覆盖而不是新增");
        let f = get(&conn, a).unwrap();
        assert!(f.content.contains("60kg"));
        // 必须已进检索编目
        assert_eq!(index::pending_count(&conn).unwrap(), 1);
        let out = index::apply_one(&conn, "note", &a.to_string()).unwrap();
        assert!(out.doc_id.is_some());
    }

    #[test]
    fn write_rejects_empty_content() {
        let conn = db();
        assert!(write(&conn, "空.md", "   ").is_err());
    }

    #[test]
    fn note_doc_is_derived_with_correct_path_and_flags() {
        let conn = db();
        let id = write(&conn, "训练/膝盖.md", "深蹲注意膝盖内扣").unwrap();
        let out = index::apply_one(&conn, "note", &id.to_string()).unwrap();
        let doc_id = out.doc_id.unwrap();

        let (path, editable, system): (String, i64, i64) = conn
            .query_row(
                "SELECT path, editable, system FROM kb_docs WHERE id = ?1",
                [doc_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(path, "笔记/训练/膝盖.md");
        assert_eq!((editable, system), (1, 0), "用户笔记可编辑且非系统");
    }

    #[test]
    fn spec_is_seeded_system_and_readonly() {
        let conn = db();
        ensure_spec(&conn).unwrap();
        let f = get_by_path(&conn, SPEC_PATH).unwrap().expect("规范文件应被播种");
        assert!(f.system, "规范文件必须是 system");
        assert!(f.content.contains("虚拟文件系统"), "内容应来自 docs/kb-vfs.md");

        // 幂等：再跑一次不改 updated_at（内容相同）
        let before: String = conn
            .query_row("SELECT updated_at FROM kb_files WHERE path = ?1", [SPEC_PATH], |r| r.get(0))
            .unwrap();
        ensure_spec(&conn).unwrap();
        let after: String = conn
            .query_row("SELECT updated_at FROM kb_files WHERE path = ?1", [SPEC_PATH], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);

        // 规范文件不可改、不可删
        assert!(rename(&conn, f.id, "笔记/偷梁换柱.md").is_err());
        assert!(delete(&conn, f.id).is_err());
        // 也无法通过 normalize 伪装进系统命名空间
        assert!(normalize_path("规范/x.md").is_err());
    }

    #[test]
    fn rename_updates_path_and_reindexes() {
        let conn = db();
        let id = write(&conn, "旧名.md", "内容").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        index::take_dirty(&conn, 100).unwrap();

        let new_path = rename(&conn, id, "新名.md").unwrap();
        assert_eq!(new_path, "笔记/新名.md");
        assert!(get(&conn, id).unwrap().path.ends_with("新名.md"));
        assert_eq!(index::pending_count(&conn).unwrap(), 1, "改名后应重索引");

        // 改到已存在的路径必须被拒
        write(&conn, "占用.md", "别的").unwrap();
        assert!(rename(&conn, id, "占用.md").is_err());
    }

    #[test]
    fn delete_removes_file_and_doc() {
        let conn = db();
        let id = write(&conn, "待删.md", "内容").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        assert_eq!(index::stats(&conn).unwrap().0, 1);

        delete(&conn, id).unwrap();
        assert!(get(&conn, id).is_err());
        assert_eq!(index::stats(&conn).unwrap().0, 0, "编目文档应一并删除");
    }

    #[test]
    fn edit_flows_through_index_and_search() {
        use crate::modules::kb::models::KbQuery;
        use crate::modules::kb::search;

        let conn = db();
        let id = write(&conn, "膝盖.md", "避免深蹲超过 60 公斤").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();

        let all = crate::modules::kb::models::SOURCE_TYPES
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();

        // 关键词搜的是**正文**（规范 §4）；文件名要走 glob
        let q = KbQuery {
            query: "深蹲".into(),
            ..Default::default()
        };
        let hits = search::search(&conn, &q, &all, None, None).unwrap();
        assert_eq!(hits.len(), 1, "笔记正文应可被检索");
        assert_eq!(hits[0].path.as_deref(), Some("笔记/膝盖.md"));
        assert!(hits[0].editable, "笔记应标记为可编辑");

        // 文件名检索走 glob
        let listed = search::glob(&conn, "笔记/*.md", 10).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, "笔记/膝盖.md");
    }
}
