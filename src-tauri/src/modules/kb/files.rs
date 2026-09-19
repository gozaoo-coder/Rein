//! 真实文件层（kb_files）：知识库里唯一「内容即真源」的存储。
//!
//! 与派生文档的边界是整个 VFS 的关键（docs/kb-vfs.md §1）：
//! - 派生文档：正文是缓存，改内容必须改源数据，重放会覆盖任何直改；
//! - 真实文件：`kb_files` 就是真源，编辑走这里再标脏，派生管线把它的内容镜像进 kb_docs。
//!
//! 路径规则（docs/ai-workspace.md §3.2）：
//! - **系统区只读**：`规范/`、`系统提示词/` 由应用播种，用户与 AI 都不可写；
//! - 已知根目录（知识区 + 领域目录）直通；其他裸路径归位到 `笔记/`（旧行为，兼容）；
//! - 派生路径是**保留区**（日期目录、`-{id}` 后缀、`附件/` 全树）：用户文件写到这里自动
//!   让位加后缀（`-v2`），绝不覆盖派生文档。

use rusqlite::{Connection, OptionalExtension};

use crate::error::{ReinError, Result};

use super::index;
use super::models::*;
use super::source::sanitize;
use super::{assets, governance};

/// 规范文件内容 = 仓库里的规范文档，单一事实源（改规范只改那一份，两端同时生效）。
const SPEC_MARKDOWN: &str = include_str!("../../../../docs/kb-vfs.md");

/// 系统提示词：随应用版本更新，AI 每轮全量读到（docs/ai-workspace.md §3.4）。
const PROMPT_ROLE: &str = r#"# 角色与语气

- 你是 Rein AI：Rein 健康生活应用的内置助手，用户的数据与文件都在你的虚拟工作区里。
- 用简体中文，语气自然亲切；直接给结论，不复述用户已知的信息，不写「好的，我来帮你…」这类过场。
- 能用工具查到的事不要反问用户；确实需要用户决策时，给两三个具体选项。
"#;

const PROMPT_WORKSPACE: &str = r#"# 工作区约定

- 全部数据与文件编目在一棵虚拟文件树里。日程/运动/饮食/课程/对话等目录是应用数据的**只读投影**：
  要改内容就改源数据（用对应的写工具），直接改这些文件没有意义，重放会覆盖。
- 可写的只有：笔记/、文档/、未分类数据/、语音/、视频/、用户记忆/，以及各领域目录里的用户子目录。
  系统区（系统提示词/、规范/）只读。
- 新内容没想好放哪就先落 `未分类数据/`；你有整理职责：用 classify_move 归到语义合适的目录，
  reason 写清依据。被用户 pin 住的文件不要动；派生路径（带日期目录或 -编号）不要占用。
- 文件可以有多种模态：优先读文本模态；需要原件时用 read_modal（音频/视频可能返回降级文本，
  这是正常降级，不要反复重试）。
- 用户说「记住 / 以后都…」用 remember；要改人物设定或长期规则就写 用户记忆/ 下的文件。
"#;

const MEMORY_ROLE_TPL: &str =
    "<!-- 角色设定：AI 该怎么称呼你、用什么语气、注意什么。有内容时每轮自动注入。 -->";
const MEMORY_RULES_TPL: &str =
    "<!-- 全局规范：你希望 AI 始终遵守的规则。有内容时每轮自动注入。 -->";

const COLS: &str =
    "id, path, content, system, kind, pinned, classify_state, created_at, updated_at";

fn row_to_file(r: &rusqlite::Row) -> rusqlite::Result<KbFile> {
    Ok(KbFile {
        id: r.get(0)?,
        path: r.get(1)?,
        content: r.get(2)?,
        system: r.get::<_, i64>(3)? != 0,
        kind: r.get(4)?,
        pinned: r.get::<_, i64>(5)? != 0,
        classify_state: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        modalities: Vec::new(),
    })
}

/// 第一段是否命中已知根目录（知识区 + 领域目录）。
fn known_root(seg: &str) -> bool {
    WRITABLE_ROOTS.contains(&seg) || DOMAIN_ROOTS.contains(&seg)
}

fn check_common(raw: &str) -> Result<()> {
    if raw.is_empty() {
        return Err(ReinError::Message("文件路径不能为空".into()));
    }
    if raw.split('/').any(|seg| seg == "..") {
        return Err(ReinError::Message(format!("路径不允许包含 ..：{raw}")));
    }
    let first = raw.split('/').next().unwrap_or("");
    if SYSTEM_ROOTS.contains(&first) {
        return Err(ReinError::Message(format!(
            "{first}/ 是系统命名空间，只能由应用更新，不能由用户写入"
        )));
    }
    Ok(())
}

fn join_sanitized(segments: &str) -> String {
    segments
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| sanitize(s, 60))
        .collect::<Vec<_>>()
        .join("/")
}

/// 把用户给的路径归位成合法的虚拟路径：
/// - 裸路径补 `笔记/` 前缀（用户只写 `膝盖.md` 也会落到 `笔记/膝盖.md`）；
/// - 已知根目录（笔记/文档/用户记忆/未分类数据/语音/视频 + 领域目录）直通；
/// - 补 `.md` 后缀；
/// - 每段过 sanitize，拒绝 `..` 与系统命名空间。
pub fn normalize_path(raw: &str) -> Result<String> {
    let raw = raw.trim().trim_start_matches('/');
    check_common(raw)?;
    let first = raw.split('/').next().unwrap_or("");
    let full = if known_root(first) {
        raw.to_string()
    } else {
        format!("{NOTE_ROOT}/{raw}")
    };
    let mut path = join_sanitized(&full);
    if !path.ends_with(".md") {
        path.push_str(".md");
    }
    Ok(path)
}

/// 媒体本体的路径归位：保留原扩展名，裸路径默认落收件箱 `未分类数据/`。
pub fn normalize_media_path(raw: &str, name: &str) -> Result<String> {
    let raw = raw.trim().trim_start_matches('/');
    if raw.split('/').any(|seg| seg == "..") {
        return Err(ReinError::Message(format!("路径不允许包含 ..：{raw}")));
    }
    let safe_name = sanitize(name, 60);
    let last = raw.rsplit('/').next().unwrap_or("");
    let (dir_raw, base) = if last.contains('.') {
        match raw.rsplit_once('/') {
            Some((d, f)) => (d.to_string(), sanitize(f, 60)),
            None => (String::new(), sanitize(raw, 60)),
        }
    } else {
        (raw.to_string(), safe_name)
    };
    if !dir_raw.is_empty() {
        check_common(&dir_raw)?;
    }
    let first = dir_raw.split('/').next().unwrap_or("");
    let dir = if dir_raw.is_empty() {
        INBOX_ROOT.to_string()
    } else if known_root(first) {
        dir_raw
    } else {
        format!("{INBOX_ROOT}/{}", sanitize(&dir_raw, 60))
    };
    let dir = join_sanitized(&dir);
    let base = if base.trim().is_empty() {
        "未命名".to_string()
    } else {
        base
    };
    Ok(if dir.is_empty() {
        base
    } else {
        format!("{dir}/{base}")
    })
}

/// 落库前的让位：目标路径若落在保留区、或与派生文档冲突，就自动换一个自由名（`-v2`）。
/// 同路径已有 kb_files 行时保持原样（写入是 upsert，改名接口另有占用检查）。
fn settle_path(conn: &Connection, path: &str) -> Result<String> {
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE path = ?1", [path], |r| {
            r.get(0)
        })
        .optional()?;
    if existing.is_some() {
        return Ok(path.to_string());
    }
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let base = path.rsplit('/').next().unwrap_or(path);
    governance::free_path(conn, dir, base)
}

/// 新建或覆盖一个文本文件（按 path 幂等）。返回文件 id。
pub fn write(conn: &Connection, raw_path: &str, content: &str) -> Result<i64> {
    if content.trim().is_empty() {
        return Err(ReinError::Message("文件内容不能为空".into()));
    }
    let path = normalize_path(raw_path)?;
    let path = settle_path(conn, &path)?;
    write_media_row(conn, &path, content, FILE_KIND_TEXT)
}

/// 直接按最终路径写一行 kb_files（内容即真源），并登记检索编目。
/// 文本笔记、上传的多模态节点、目录占位都走这里。
pub fn write_media_row(conn: &Connection, path: &str, content: &str, kind: &str) -> Result<i64> {
    governance::ensure_writable(path)?;
    let classify = if path == INBOX_ROOT || path.starts_with(&format!("{INBOX_ROOT}/")) {
        CLASSIFY_INBOX
    } else {
        CLASSIFY_MANUAL
    };
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE path = ?1", [path], |r| {
            r.get(0)
        })
        .optional()?;
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE kb_files SET content = ?2, kind = ?3, updated_at = datetime('now') WHERE id = ?1",
                rusqlite::params![id, content, kind],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO kb_files(path, content, system, kind, pinned, classify_state, created_at, updated_at)
                 VALUES (?1, ?2, 0, ?3, 0, ?4, datetime('now'), datetime('now'))",
                rusqlite::params![path, content, kind, classify],
            )?;
            conn.last_insert_rowid()
        }
    };
    index::mark_dirty(conn, "note", &id.to_string())?;
    Ok(id)
}

/// 改名 / 移动。系统文件拒绝。返回新路径。`id` 可以是文档 id 或文件 id。
pub fn rename(conn: &Connection, id: i64, raw_path: &str) -> Result<String> {
    let id = resolve_file_id(conn, id)?;
    assert_not_system(conn, id, "改名")?;
    let mut path = normalize_path(raw_path)?;
    // 落到保留区或撞上派生文档时自动让位（改名不该毁掉投影）
    if governance::is_reserved_path(&path) {
        let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let base = path.rsplit('/').next().unwrap_or(&path);
        path = governance::free_path(conn, dir, base)?;
    }
    let dup: Option<i64> = conn
        .query_row(
            "SELECT id FROM kb_files WHERE path = ?1 AND id <> ?2",
            rusqlite::params![path, id],
            |r| r.get(0),
        )
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
/// 返回该节点的 fs 本体相对路径——调用方据此清理磁盘（数据库行由外键级联清掉 kb_assets）。
pub fn delete(conn: &Connection, id: i64) -> Result<Vec<String>> {
    let id = resolve_file_id(conn, id)?;
    assert_not_system(conn, id, "删除")?;
    let refs = assets::fs_refs(conn, id)?;
    let n = conn.execute("DELETE FROM kb_files WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ReinError::Message(format!("文件不存在：id={id}")));
    }
    // 编目文档一并清掉（显式删块以维护 FTS，见 index.rs 的说明）
    index::delete_doc(conn, "note", &id.to_string())?;
    Ok(refs)
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
    via_doc.and_then(|s| s.parse::<i64>().ok()).ok_or_else(|| {
        ReinError::Message(format!("文件不存在：id={id}（先用 glob_knowledge 查 id）"))
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<KbFile> {
    let fid = resolve_file_id(conn, id)?;
    let mut f = conn
        .query_row(
            &format!("SELECT {COLS} FROM kb_files WHERE id = ?1"),
            [fid],
            row_to_file,
        )
        .optional()?
        .ok_or_else(|| ReinError::Message(format!("文件不存在：id={id}")))?;
    f.modalities = assets::modals_for_file(conn, fid)?;
    Ok(f)
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
        .query_row("SELECT system FROM kb_files WHERE id = ?1", [id], |r| {
            r.get(0)
        })
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
    seed_system_file(conn, SPEC_PATH, SPEC_MARKDOWN)
}

/// 系统文件播种：内容随应用版本更新（是「系统提示词」，不是用户内容）。
fn seed_system_file(conn: &Connection, path: &str, content: &str) -> Result<()> {
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, content FROM kb_files WHERE path = ?1",
            [path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    match existing {
        Some((_id, old)) if old == content => Ok(()),
        Some((id, _)) => {
            conn.execute(
                "UPDATE kb_files SET content = ?2, kind = ?3, updated_at = datetime('now') WHERE id = ?1",
                rusqlite::params![id, content, FILE_KIND_TEXT],
            )?;
            index::mark_dirty(conn, "note", &id.to_string())
        }
        None => {
            conn.execute(
                "INSERT INTO kb_files(path, content, system, kind, pinned, classify_state, created_at, updated_at)
                 VALUES (?1, ?2, 1, ?3, 0, ?4, datetime('now'), datetime('now'))",
                rusqlite::params![path, content, FILE_KIND_TEXT, CLASSIFY_MANUAL],
            )?;
            index::mark_dirty(conn, "note", &conn.last_insert_rowid().to_string())
        }
    }
}

/// 用户记忆的模板：只在缺失时创建，**绝不覆盖**用户的编辑（内容只有一段 HTML 注释，
/// 注入层会跳过它，所以放着不占每轮预算）。
fn seed_user_template(conn: &Connection, path: &str, tpl: &str) -> Result<()> {
    let exists: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE path = ?1", [path], |r| {
            r.get(0)
        })
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO kb_files(path, content, system, kind, pinned, classify_state, created_at, updated_at)
         VALUES (?1, ?2, 0, ?3, 0, ?4, datetime('now'), datetime('now'))",
        rusqlite::params![path, tpl, FILE_KIND_TEXT, CLASSIFY_MANUAL],
    )?;
    index::mark_dirty(conn, "note", &conn.last_insert_rowid().to_string())
}

/// 启动对账的第一步：播种全部系统文件与默认目录（幂等）。
///
/// 包含：`规范/知识库规范.md`、`系统提示词/*`（随版本更新）、`用户记忆/角色设定.md` 与
/// `用户记忆/全局规范.md`（只在缺失时建）、`未分类数据/` 收件箱目录（让默认树完整可见）。
pub fn ensure_system_files(conn: &Connection) -> Result<()> {
    ensure_spec(conn)?;
    seed_system_file(
        conn,
        &format!("{SYSTEM_PROMPT_ROOT}/角色与语气.md"),
        PROMPT_ROLE,
    )?;
    seed_system_file(
        conn,
        &format!("{SYSTEM_PROMPT_ROOT}/工作区约定.md"),
        PROMPT_WORKSPACE,
    )?;
    seed_user_template(
        conn,
        &format!("{USER_MEMORY_ROOT}/角色设定.md"),
        MEMORY_ROLE_TPL,
    )?;
    seed_user_template(
        conn,
        &format!("{USER_MEMORY_ROOT}/全局规范.md"),
        MEMORY_RULES_TPL,
    )?;

    let inbox: Option<i64> = conn
        .query_row(
            "SELECT id FROM kb_files WHERE path = ?1",
            [INBOX_ROOT],
            |r| r.get(0),
        )
        .optional()?;
    if inbox.is_none() {
        conn.execute(
            "INSERT INTO kb_files(path, content, system, kind, pinned, classify_state, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, 0, ?4, datetime('now'), datetime('now'))",
            rusqlite::params![
                INBOX_ROOT,
                format!("【目录】{INBOX_ROOT}"),
                FILE_KIND_FOLDER,
                CLASSIFY_INBOX
            ],
        )?;
        index::mark_dirty(conn, "note", &conn.last_insert_rowid().to_string())?;
    }
    Ok(())
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
        assert!(
            normalize_path("规范/伪造.md").is_err(),
            "系统命名空间不可写"
        );
        assert!(normalize_path("  ").is_err());
    }

    #[test]
    fn path_segments_are_sanitized() {
        // 文件名里的非法字符与分隔符必须被净化
        // 斜杠是分段符（保留），段内非法字符净化
        assert_eq!(
            normalize_path("膝盖/深蹲*问号?.md").unwrap(),
            "笔记/膝盖/深蹲-问号-.md"
        );
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
        let f = get_by_path(&conn, SPEC_PATH)
            .unwrap()
            .expect("规范文件应被播种");
        assert!(f.system, "规范文件必须是 system");
        assert!(
            f.content.contains("虚拟文件系统"),
            "内容应来自 docs/kb-vfs.md"
        );

        // 幂等：再跑一次不改 updated_at（内容相同）
        let before: String = conn
            .query_row(
                "SELECT updated_at FROM kb_files WHERE path = ?1",
                [SPEC_PATH],
                |r| r.get(0),
            )
            .unwrap();
        ensure_spec(&conn).unwrap();
        let after: String = conn
            .query_row(
                "SELECT updated_at FROM kb_files WHERE path = ?1",
                [SPEC_PATH],
                |r| r.get(0),
            )
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
