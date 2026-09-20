//! 目录治理：AI 主动分类的落地层（docs/ai-workspace.md §3）。
//!
//! 三件事：
//! 1. **保留区**：派生文档的路径（`{日期}/` 段、`-{id}` 后缀、`附件/` 全树）属于源表的投影，
//!    用户文件写到这里必须自动让位（加后缀），绝不覆盖派生文档。
//! 2. **结构约束**：深度 ≤ 4、同级条目 ≤ 50、单次批量 ≤ 200；AI 自动整理还有 24h 防抖
//!    （同一路径一天内不再自动挪），一切移动写 `kb_fs_moves` 审计、可按批撤销。
//! 3. **用户优先**：钉住（pinned）的文件 AI 不得移动；用户自己的移动一律记为 manual。
//!
//! 系统区（`规范/`、`系统提示词/`）在写入口就被拒——这里再挡一次，二道防线。

use rusqlite::{Connection, OptionalExtension};

use crate::error::{ReinError, Result};

use super::files;
use super::index;
use super::models::*;

/// 目录最大深度（路径段数）。
pub const MAX_DEPTH: usize = 4;
/// 单目录最大条目数（同级）。
pub const MAX_SIBLINGS: i64 = 50;
/// 一次批量操作的上限。
pub const MAX_BATCH: usize = 200;

fn is_date_dir(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..].iter().all(|c| c.is_ascii_digit())
}

/// 系统区（只读）路径判定。
pub fn is_system_path(path: &str) -> bool {
    let first = path.trim_start_matches('/').split('/').next().unwrap_or("");
    SYSTEM_ROOTS.contains(&first)
}

/// 保留区判定：派生文档占用的路径形态。
/// - `附件/` 整棵树都是编目；
/// - 任意一段是 `YYYY-MM-DD`（派生文档按日期分目录）；
/// - **领域目录下**的文件名以 `-数字` 结尾（派生文档的 `-{id}` 唯一后缀）。
///
/// 最后一条限定在领域目录：知识区（笔记/文档/未分类数据/语音/视频/用户记忆）里
/// 「安排表9-10.md」这类正常名字不该被误伤；语音的派生文档落在日期目录里，由第二条覆盖。
pub fn is_reserved_path(path: &str) -> bool {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return true;
    }
    if segs[0] == "附件" {
        return true;
    }
    if segs.iter().any(|s| is_date_dir(s)) {
        return true;
    }
    if !DOMAIN_ROOTS.contains(&segs[0]) {
        return false;
    }
    let file = *segs.last().unwrap();
    let stem = file.rsplit_once('.').map(|(a, _)| a).unwrap_or(file);
    if let Some((_, tail)) = stem.rsplit_once('-') {
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    false
}

/// 写入门槛：系统区不可写。保留区不在这里拒——由 `free_path` 自动让位（加后缀）。
pub fn ensure_writable(path: &str) -> Result<()> {
    if is_system_path(path) {
        return Err(ReinError::Message(format!(
            "{path} 在系统命名空间（{}），只读；它的内容随应用版本更新",
            SYSTEM_ROOTS.join(" / ")
        )));
    }
    Ok(())
}

fn depth_of(path: &str) -> usize {
    path.split('/').filter(|s| !s.is_empty()).count()
}

/// 目录里的直接条目数（同级上限用）。
fn siblings(conn: &Connection, dir: &str) -> Result<i64> {
    let like = if dir.is_empty() {
        "%".to_string()
    } else {
        format!("{dir}/%")
    };
    let depth = depth_of(dir) + 1;
    let mut stmt = conn.prepare("SELECT path FROM kb_files WHERE path LIKE ?1")?;
    let rows = stmt.query_map([like], |r| r.get::<_, String>(0))?;
    let mut n = 0;
    for p in rows {
        if depth_of(&p?) == depth {
            n += 1;
        }
    }
    Ok(n)
}

/// 目标路径是否已被占用（kb_files 或派生文档）。冲突就让位。
fn occupied(conn: &Connection, path: &str) -> Result<bool> {
    let a: Option<i64> = conn
        .query_row("SELECT id FROM kb_files WHERE path = ?1", [path], |r| {
            r.get(0)
        })
        .optional()?;
    if a.is_some() {
        return Ok(true);
    }
    let b: Option<i64> = conn
        .query_row(
            "SELECT id FROM kb_docs WHERE path = ?1 LIMIT 1",
            [path],
            |r| r.get(0),
        )
        .optional()?;
    Ok(b.is_some())
}

/// 目录侧的安全化：保留形态的**目录段**整体让位，而不是试图在保留目录里换文件名
/// （日期目录里换任何名字都仍是保留路径）。规则：
/// - `YYYY-MM-DD` 段 → 追加 `-用户`（如 `运动/2026-09-10/` → `运动/2026-09-10-用户/`）；
/// - `附件/` 整树是编目 → 改投收件箱 `未分类数据/`。
fn safe_dir(dir: &str) -> String {
    let segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    if segs.first() == Some(&"附件") {
        return INBOX_ROOT.to_string();
    }
    segs.iter()
        .map(|seg| {
            if is_date_dir(seg) {
                format!("{seg}-用户")
            } else {
                (*seg).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 在 `dir` 下为 `basename` 找一个自由路径：
/// 保留目录先被 `safe_dir` 换掉，保留文件名（`-数字` 后缀）与已占用则加 `-v2`、`-v3` 后缀。
pub fn free_path(conn: &Connection, dir: &str, basename: &str) -> Result<String> {
    let dir = safe_dir(dir.trim().trim_matches('/'));
    let base = basename.trim().trim_matches('/');
    if base.is_empty() {
        return Err(ReinError::Message("文件名不能为空".into()));
    }
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
        let path = if dir.is_empty() {
            name
        } else {
            format!("{dir}/{name}")
        };
        if is_system_path(&path) {
            return Err(ReinError::Message(format!("{path} 在系统命名空间，只读")));
        }
        if is_reserved_path(&path) {
            continue;
        }
        if !occupied(conn, &path)? {
            return Ok(path);
        }
    }
    Err(ReinError::Message(format!(
        "在 {dir}/ 下找不到可用文件名（{base}）"
    )))
}

/// 建目录（空目录也要在文件树里可见，所以目录是一个 kind='folder' 的节点）。
pub fn mkdir(conn: &Connection, raw: &str, reason: &str, source: &str) -> Result<String> {
    let path = raw.trim().trim_matches('/').to_string();
    if path.is_empty() {
        return Err(ReinError::Message("目录路径不能为空".into()));
    }
    ensure_writable(&path)?;
    if depth_of(&path) > MAX_DEPTH {
        return Err(ReinError::Message(format!(
            "目录深度超过上限（{MAX_DEPTH} 层）：{path}"
        )));
    }
    if is_reserved_path(&path) {
        return Err(ReinError::Message(format!(
            "{path} 落在派生文档的保留命名空间里，不能建目录"
        )));
    }
    if occupied(conn, &path)? {
        return Err(ReinError::Message(format!("路径已存在：{path}")));
    }
    let parent = path.rsplit_once('/').map(|(p, _)| p.to_string());
    if let Some(parent) = parent.filter(|p| !p.is_empty()) {
        if siblings(conn, &parent)? >= MAX_SIBLINGS {
            return Err(ReinError::Message(format!(
                "{parent}/ 下条目已达上限（{MAX_SIBLINGS}）"
            )));
        }
    }
    files::write_media_row(conn, &path, &format!("【目录】{path}"), FILE_KIND_FOLDER)?;
    audit(conn, source, "mkdir", "", &path, reason)?;
    Ok(path)
}

fn audit(
    conn: &Connection,
    source: &str,
    op: &str,
    from: &str,
    to: &str,
    reason: &str,
) -> Result<String> {
    let batch = uuid::Uuid::new_v4().to_string();
    audit_in_batch(conn, &batch, source, op, from, to, reason)?;
    Ok(batch)
}

fn audit_in_batch(
    conn: &Connection,
    batch: &str,
    source: &str,
    op: &str,
    from: &str,
    to: &str,
    reason: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO kb_fs_moves(batch_id, source, op, path_from, path_to, reason, at, undone)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), 0)",
        rusqlite::params![batch, source, op, from, to, reason],
    )?;
    Ok(())
}

/// 一次移动的结果（供工具层回话）。
#[derive(Debug, Clone)]
pub struct MoveOutcome {
    pub from: String,
    pub to: String,
    pub batch_id: String,
}

/// 把文件移进目标目录。`source` ∈ ai | user。
pub fn move_to(
    conn: &Connection,
    id: i64,
    to_dir: &str,
    reason: &str,
    source: &str,
) -> Result<MoveOutcome> {
    let fid = files::resolve_file_id(conn, id)?;
    let (path, pinned): (String, i64) = conn
        .query_row(
            "SELECT path, pinned FROM kb_files WHERE id = ?1",
            [fid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| ReinError::Message(format!("文件不存在：id={id}")))?;
    ensure_writable(&path)?;

    if source == "ai" && pinned != 0 {
        return Err(ReinError::Message(format!(
            "{path} 被用户钉住（pin），AI 不能移动它"
        )));
    }
    // AI 自动整理防抖：这个路径若是 AI 在 24 小时内刚放好的，就不再挪（同一文件反复搬家的刹车）
    if source == "ai" {
        let recent: Option<i64> = conn
            .query_row(
                "SELECT id FROM kb_fs_moves
                 WHERE path_to = ?1 AND source = 'ai' AND op = 'move' AND undone = 0
                   AND at > datetime('now', '-1 day') LIMIT 1",
                [&path],
                |r| r.get(0),
            )
            .optional()?;
        if recent.is_some() {
            return Err(ReinError::Message(format!(
                "{path} 一天内已被自动整理过，暂不再移动（防抖）"
            )));
        }
    }

    let dir = to_dir.trim().trim_matches('/');
    if !dir.is_empty() && depth_of(dir) + 1 > MAX_DEPTH {
        return Err(ReinError::Message(format!(
            "目标目录过深（上限 {MAX_DEPTH} 层）：{dir}"
        )));
    }
    if siblings(conn, dir)? >= MAX_SIBLINGS {
        return Err(ReinError::Message(format!(
            "{dir}/ 下条目已达上限（{MAX_SIBLINGS}）"
        )));
    }
    let basename = path.rsplit('/').next().unwrap_or(&path);
    let to = free_path(conn, dir, basename)?;
    if to == path {
        return Ok(MoveOutcome {
            from: path.clone(),
            to: path,
            batch_id: String::new(),
        });
    }

    let classify = if dir == INBOX_ROOT {
        CLASSIFY_INBOX
    } else {
        CLASSIFY_FILED
    };
    conn.execute(
        "UPDATE kb_files SET path = ?2, classify_state = ?3, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![fid, to, classify],
    )?;
    index::mark_dirty(conn, "note", &fid.to_string())?;
    let batch = audit(conn, source, "move", &path, &to, reason)?;
    Ok(MoveOutcome {
        from: path,
        to,
        batch_id: batch,
    })
}

/// 钉住 / 取消钉住（用户手动归类的一部分）。
pub fn pin(conn: &Connection, id: i64, pinned: bool, source: &str) -> Result<String> {
    let fid = files::resolve_file_id(conn, id)?;
    let path: String = conn
        .query_row("SELECT path FROM kb_files WHERE id = ?1", [fid], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| ReinError::Message(format!("文件不存在：id={id}")))?;
    ensure_writable(&path)?;
    conn.execute(
        "UPDATE kb_files SET pinned = ?2, classify_state = ?3, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![
            fid,
            if pinned { 1 } else { 0 },
            if pinned { CLASSIFY_MANUAL } else { CLASSIFY_FILED }
        ],
    )?;
    audit(
        conn,
        source,
        if pinned { "pin" } else { "unpin" },
        &path,
        &path,
        if pinned {
            "用户钉住"
        } else {
            "取消钉住"
        },
    )?;
    Ok(path)
}

/// 审计流水（最近的在前）。
pub fn moves(conn: &Connection, limit: i64) -> Result<Vec<KbFsMove>> {
    let limit = limit.clamp(1, 200);
    let mut stmt = conn.prepare(
        "SELECT id, batch_id, source, op, path_from, path_to, reason, at, undone
         FROM kb_fs_moves ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(KbFsMove {
            id: r.get(0)?,
            batch_id: r.get(1)?,
            source: r.get(2)?,
            op: r.get(3)?,
            path_from: r.get(4)?,
            path_to: r.get(5)?,
            reason: r.get(6)?,
            at: r.get(7)?,
            undone: r.get::<_, i64>(8)? != 0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 整批撤销一批移动。返回撤销条数。
pub fn undo(conn: &Connection, batch_id: &str) -> Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT id, path_from, path_to FROM kb_fs_moves
         WHERE batch_id = ?1 AND op IN ('move','mkdir','rename') AND undone = 0 ORDER BY id DESC",
    )?;
    let rows: Vec<(i64, String, String)> = stmt
        .query_map([batch_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut n = 0;
    for (mid, from, to) in rows {
        // 一次撤销也有上限：误触「撤销全部」不该把几百个文件瞬间搬回去
        if n as usize >= MAX_BATCH {
            break;
        }
        if !from.is_empty() && !to.is_empty() {
            let fid: Option<i64> = conn
                .query_row("SELECT id FROM kb_files WHERE path = ?1", [&to], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(fid) = fid {
                // 原路径被占就换个自由名，不覆盖任何现有文件
                let dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
                let base = from.rsplit('/').next().unwrap_or(&from);
                let back = free_path(conn, dir, base)?;
                conn.execute(
                    "UPDATE kb_files SET path = ?2, updated_at = datetime('now') WHERE id = ?1",
                    rusqlite::params![fid, back],
                )?;
                index::mark_dirty(conn, "note", &fid.to_string())?;
            }
        }
        conn.execute("UPDATE kb_fs_moves SET undone = 1 WHERE id = ?1", [mid])?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::files;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn reserved_paths_cover_date_dirs_id_suffix_and_attachments() {
        assert!(is_reserved_path("日程/2026-09-19/训练-42.md"));
        assert!(is_reserved_path("运动/2026-01-02/x.md"));
        assert!(is_reserved_path("课程/腿部力量-42.md"));
        assert!(is_reserved_path("附件/日程/t1/1-knee.jpg"));
        assert!(!is_reserved_path("未分类数据/2026/计划.md"));
        assert!(!is_reserved_path("笔记/训练/深蹲.md"));
        assert!(!is_reserved_path("运动/知识/跑步计划.md"));
        // 后缀必须是纯数字才算派生 id
        assert!(!is_reserved_path("笔记/计划-v2.md"));
        // 知识区里「-数字」是正常文件名（安排表9-10.md 不是派生文档）
        assert!(!is_reserved_path("文档/军事技能训练安排表9-10.md"));
        assert!(!is_reserved_path("笔记/周报-3.md"));
    }

    #[test]
    fn free_path_avoids_reserved_and_occupied() {
        let conn = db();
        assert_eq!(free_path(&conn, "笔记", "膝盖.md").unwrap(), "笔记/膝盖.md");
        // 保留形态（-42）会让位
        assert_eq!(
            free_path(&conn, "课程", "腿部-42.md").unwrap(),
            "课程/腿部-42-v2.md"
        );
        // 保留目录整体让位：日期目录 → {日期}-用户/，而不是在日期目录里换名字
        assert_eq!(
            free_path(&conn, "运动/2026-09-10", "腿部-42.md").unwrap(),
            "运动/2026-09-10-用户/腿部-42-v2.md"
        );
        // 附件/ 整树是编目：用户内容改投收件箱
        assert_eq!(
            free_path(&conn, "附件/日程/t1", "照片.jpg").unwrap(),
            "未分类数据/照片.jpg"
        );
        // 已占用会让位
        files::write(&conn, "笔记/a.md", "x").unwrap();
        assert_eq!(free_path(&conn, "笔记", "a.md").unwrap(), "笔记/a-v2.md");
    }

    #[test]
    fn system_paths_are_rejected() {
        assert!(ensure_writable("规范/x.md").is_err());
        assert!(ensure_writable("系统提示词/角色与语气.md").is_err());
        assert!(ensure_writable("未分类数据/x.md").is_ok());
    }

    #[test]
    fn move_files_into_domain_dir_with_audit_and_pin_guard() {
        let conn = db();
        let id = files::write(&conn, "未分类数据/跑步计划.md", "每周三次").unwrap();
        let out = move_to(&conn, id, "运动", "内容与训练相关", "ai").unwrap();
        assert_eq!(out.from, "未分类数据/跑步计划.md");
        assert_eq!(out.to, "运动/跑步计划.md");
        assert!(!out.batch_id.is_empty());

        let f = files::get(&conn, id).unwrap();
        assert_eq!(f.classify_state, CLASSIFY_FILED);
        assert!(!f.pinned);
        let log = moves(&conn, 10).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].op, "move");

        // 钉住后 AI 不得再动
        pin(&conn, id, true, "user").unwrap();
        let err = move_to(&conn, id, "笔记", "再挪一次", "ai").unwrap_err();
        assert!(err.to_string().contains("钉住"));

        // 撤销
        let n = undo(&conn, &out.batch_id).unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            files::get(&conn, id).unwrap().path,
            "未分类数据/跑步计划.md"
        );
    }

    #[test]
    fn ai_moves_are_debounced_within_a_day() {
        let conn = db();
        let id = files::write(&conn, "未分类数据/a.md", "内容").unwrap();
        move_to(&conn, id, "笔记", "第一次", "ai").unwrap();
        let err = move_to(&conn, id, "文档", "第二次", "ai").unwrap_err();
        assert!(err.to_string().contains("防抖"), "{err}");
        // 用户手动移动不受防抖限制
        assert!(move_to(&conn, id, "文档", "用户自己挪", "user").is_ok());
    }

    #[test]
    fn depth_and_sibling_limits_hold() {
        let conn = db();
        let id = files::write(&conn, "未分类数据/a.md", "内容").unwrap();
        let deep = "一/二/三/四";
        let err = move_to(&conn, id, deep, "太深", "user").unwrap_err();
        assert!(err.to_string().contains("过深"));

        // 同级上限：塞满 50 个
        for i in 0..MAX_SIBLINGS {
            files::write(&conn, &format!("笔记/n{i}.md"), "x").unwrap();
        }
        let err = move_to(&conn, id, "笔记", "满了", "user").unwrap_err();
        assert!(err.to_string().contains("上限"));
    }

    #[test]
    fn mkdir_makes_visible_folder_node_and_rejects_reserved() {
        let conn = db();
        let p = mkdir(&conn, "运动/知识", "给训练资料建目录", "ai").unwrap();
        assert_eq!(p, "运动/知识");
        let f: (String,) = conn
            .query_row("SELECT kind FROM kb_files WHERE path = ?1", [&p], |r| {
                Ok((r.get(0)?,))
            })
            .unwrap();
        assert_eq!(f.0, FILE_KIND_FOLDER);
        assert!(mkdir(&conn, "运动/2026-09-19", "保留区", "ai").is_err());
        assert!(mkdir(&conn, "系统提示词/x", "系统区", "ai").is_err());
    }
}
