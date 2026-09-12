//! 长期记忆：AI 从对话中提炼的「对用户的认知」，以及喂给系统提示词的那一小段文字。
//!
//! 编排在**前端**（模型调用由 WebView 里的 pi-ai 直连 provider，Rust 不调模型，见 modules/ai/mod.rs）。
//! 前端把「会话消息 + 现有记忆清单」交给模型，模型返回严格 JSON 的增/改/删，再调 `kb_memory_apply`
//! 落到这里。把「抽取」与「去重决策」压成**一次**模型调用（让模型看到现有记忆后直接给出合并结果），
//! 比 OpenViking 的「抽取 + 向量预筛 + LLM 去重」两轮省一半成本。
//!
//! 记忆不是独立系统：它是 kb_docs 的一类来源（source_type='memory'），所以天然进入同一套检索与召回。

use rusqlite::Connection;
#[cfg(test)]
use rusqlite::OptionalExtension;
use serde_json::json;

use crate::error::{ReinError, Result};

use super::index;
use super::models::{KbCognition, KbMemory, MemoryApplyResult, MemoryCandidate, MEMORY_TYPES};
use super::source::mem_type_label;

/// 注入 prompt 的记忆条数上限。每轮都要进系统提示词，必须克制。
const COGNITION_LIMIT: usize = 24;
/// 注入块的总字符上限，兜底防止单条超长记忆把提示词撑起来。
const COGNITION_MAX_CHARS: usize = 1200;

const COLS: &str = "id, mem_type, topic, content, confidence, active_count, source_chat_id, created_at, updated_at";

fn row_to_memory(r: &rusqlite::Row) -> rusqlite::Result<KbMemory> {
    Ok(KbMemory {
        id: r.get(0)?,
        mem_type: r.get(1)?,
        topic: r.get(2)?,
        content: r.get(3)?,
        confidence: r.get(4)?,
        active_count: r.get(5)?,
        source_chat_id: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

pub fn list(conn: &Connection, mem_type: Option<&str>) -> Result<Vec<KbMemory>> {
    let (sql, binds): (String, Vec<String>) = match mem_type.filter(|t| !t.is_empty()) {
        Some(t) => (
            format!("SELECT {COLS} FROM kb_memories WHERE mem_type = ?1 ORDER BY updated_at DESC, id DESC"),
            vec![t.to_string()],
        ),
        None => (
            format!("SELECT {COLS} FROM kb_memories ORDER BY updated_at DESC, id DESC"),
            vec![],
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = if binds.is_empty() {
        stmt.query_map([], row_to_memory)?
            .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([binds[0].as_str()], row_to_memory)?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

fn normalize_type(t: &str) -> String {
    let t = t.trim();
    if MEMORY_TYPES.contains(&t) {
        t.to_string()
    } else {
        // 模型偶尔会自造类型，收敛到最接近的兜底值而不是报错拒收
        "preference".to_string()
    }
}

/// 落库记忆变更。整体在一个事务里，并留一份 kb_memory_diffs 审计。
pub fn apply(
    conn: &Connection,
    candidates: &[MemoryCandidate],
    chat_id: Option<&str>,
    source_message_ids: &[String],
) -> Result<MemoryApplyResult> {
    let mut result = MemoryApplyResult {
        added: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
    };
    if candidates.is_empty() {
        return Ok(result);
    }

    let tx = conn.unchecked_transaction()?;
    let mut touched: Vec<i64> = Vec::new();
    let src_ids = serde_json::to_string(source_message_ids)?;

    for c in candidates {
        match c.op.as_str() {
            "add" => {
                let content = c.content.trim();
                if content.is_empty() {
                    result.skipped += 1;
                    continue;
                }
                let mem_type = normalize_type(&c.mem_type);
                let topic = c.topic.trim();
                let n = tx.execute(
                    "INSERT OR IGNORE INTO kb_memories(mem_type, topic, content, confidence,
                            source_chat_id, source_message_ids, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))",
                    rusqlite::params![
                        mem_type,
                        topic,
                        content,
                        c.confidence.unwrap_or(0.7),
                        chat_id,
                        src_ids,
                    ],
                )?;
                if n == 0 {
                    // UNIQUE(mem_type, topic, content) 命中：同一条记忆被反复抽取是常态，
                    // 这不算失败，也不该重复计数。
                    result.skipped += 1;
                } else {
                    result.added += 1;
                    touched.push(tx.last_insert_rowid());
                }
            }
            "update" => {
                let Some(id) = c.id else {
                    result.skipped += 1;
                    continue;
                };
                let content = c.content.trim();
                if content.is_empty() {
                    result.skipped += 1;
                    continue;
                }
                let n = tx.execute(
                    "UPDATE kb_memories SET mem_type = ?2, topic = ?3, content = ?4,
                            confidence = ?5, source_message_ids = ?6, updated_at = datetime('now')
                     WHERE id = ?1",
                    rusqlite::params![
                        id,
                        normalize_type(&c.mem_type),
                        c.topic.trim(),
                        content,
                        c.confidence.unwrap_or(0.7),
                        src_ids,
                    ],
                )?;
                if n > 0 {
                    result.updated += 1;
                    touched.push(id);
                } else {
                    result.skipped += 1;
                }
            }
            "delete" => {
                let Some(id) = c.id else {
                    result.skipped += 1;
                    continue;
                };
                let n = tx.execute("DELETE FROM kb_memories WHERE id = ?1", [id])?;
                if n > 0 {
                    result.deleted += 1;
                    // 记忆没了，对应的知识库文档也要跟着走
                    index::delete_doc(&tx, "memory", &id.to_string())?;
                } else {
                    result.skipped += 1;
                }
            }
            other => {
                return Err(ReinError::Message(format!(
                    "记忆操作只支持 add / update / delete，收到：{other}"
                )))
            }
        }
    }

    // 变更过的记忆重新进索引队列
    for id in touched {
        index::mark_dirty(&tx, "memory", &id.to_string())?;
    }

    tx.execute(
        "INSERT INTO kb_memory_diffs(chat_id, at, ops_json) VALUES (?1, datetime('now'), ?2)",
        rusqlite::params![chat_id, serde_json::to_string(&json!({
            "candidates": candidates.len(),
            "added": result.added,
            "updated": result.updated,
            "deleted": result.deleted,
            "skipped": result.skipped,
        }))?],
    )?;

    tx.commit()?;
    Ok(result)
}

/// 删除一条记忆（AI 的 forget 工具与设置页的手动清理都用它）。
pub fn delete(conn: &Connection, id: i64) -> Result<bool> {
    let n = conn.execute("DELETE FROM kb_memories WHERE id = ?1", [id])?;
    if n > 0 {
        index::delete_doc(conn, "memory", &id.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// 构建喂给系统提示词的紧凑认知块。
///
/// 这一段直接进每轮请求，所以排序按「最近被用到 + 置信度高」，并做总量截断。
/// 只做 L0 呈现：一条一行，不带来源与时间戳——模型需要细节时会去调 search_knowledge。
pub fn cognition(conn: &Connection, limit: Option<usize>) -> Result<KbCognition> {
    let limit = limit.unwrap_or(COGNITION_LIMIT) as i64;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM kb_memories
         ORDER BY active_count DESC, confidence DESC, updated_at DESC
         LIMIT ?1"
    ))?;
    let memories: Vec<KbMemory> = stmt
        .query_map([limit], row_to_memory)?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut text = String::new();
    for m in &memories {
        let line = format!("- [{}] {}", mem_type_label(&m.mem_type), m.content.trim());
        if text.chars().count() + line.chars().count() + 1 > COGNITION_MAX_CHARS {
            break;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&line);
    }

    Ok(KbCognition { memories, text })
}

/// 记忆被注入后计数，用于后续排序。注入即「用到了」。
pub fn bump_active(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE kb_memories SET active_count = active_count + 1 WHERE id = ?1",
            [id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub fn count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM kb_memories", [], |r| r.get(0))?)
}

/// 最近一次记忆抽取的审计记录（供设置页展示「AI 刚记住了什么」）。
#[cfg(test)]
pub fn last_diff(conn: &Connection) -> Result<Option<(String, String)>> {
    Ok(conn
        .query_row(
            "SELECT at, ops_json FROM kb_memory_diffs ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn cand(op: &str, t: &str, topic: &str, content: &str) -> MemoryCandidate {
        MemoryCandidate {
            op: op.into(),
            id: None,
            mem_type: t.into(),
            topic: topic.into(),
            content: content.into(),
            confidence: None,
        }
    }

    #[test]
    fn add_then_duplicate_is_skipped() {
        let conn = db();
        let c = vec![cand("add", "constraint", "膝盖", "避免深蹲过深")];
        let r1 = apply(&conn, &c, Some("c1"), &[]).unwrap();
        assert_eq!((r1.added, r1.skipped), (1, 0));

        // 同一条被再次抽取（跨会话很常见）必须幂等
        let r2 = apply(&conn, &c, Some("c2"), &[]).unwrap();
        assert_eq!((r2.added, r2.skipped), (0, 1));
        assert_eq!(count(&conn).unwrap(), 1);
    }

    #[test]
    fn add_registers_a_knowledge_doc() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "preference", "饮食", "不喜欢香菜")],
            Some("c1"),
            &[],
        )
        .unwrap();
        // 记忆必须自动进索引队列，否则 search_knowledge 搜不到
        assert_eq!(index::pending_count(&conn).unwrap(), 1);
        let id: i64 = conn.query_row("SELECT id FROM kb_memories", [], |r| r.get(0)).unwrap();
        let out = index::apply_one(&conn, "memory", &id.to_string()).unwrap();
        assert!(out.doc_id.is_some());

        let (docs, _, _) = index::stats(&conn).unwrap();
        assert_eq!(docs, 1);
    }

    #[test]
    fn update_changes_content_and_reindexes() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "训练", "上周把深蹲换成腿举")], None, &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM kb_memories", [], |r| r.get(0)).unwrap();
        index::apply_one(&conn, "memory", &id.to_string()).unwrap();
        index::take_dirty(&conn, 100).unwrap();

        let mut c = cand("update", "event", "训练", "因为膝盖不适，把深蹲换成了腿举");
        c.id = Some(id);
        let r = apply(&conn, &[c], None, &[]).unwrap();
        assert_eq!(r.updated, 1);
        let m = &list(&conn, None).unwrap()[0];
        assert!(m.content.contains("膝盖不适"));
        assert_eq!(index::pending_count(&conn).unwrap(), 1, "更新后应重新入索引队列");
    }

    #[test]
    fn update_without_id_is_skipped_not_crashing() {
        let conn = db();
        let r = apply(&conn, &[cand("update", "event", "t", "x")], None, &[]).unwrap();
        assert_eq!(r.skipped, 1);
        assert_eq!(count(&conn).unwrap(), 0);
    }

    #[test]
    fn delete_removes_memory_and_its_doc() {
        let conn = db();
        apply(&conn, &[cand("add", "preference", "饮食", "不吃辣")], None, &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM kb_memories", [], |r| r.get(0)).unwrap();
        index::apply_one(&conn, "memory", &id.to_string()).unwrap();
        assert_eq!(index::stats(&conn).unwrap().0, 1);

        let mut c = cand("delete", "", "", "");
        c.id = Some(id);
        let r = apply(&conn, &[c], None, &[]).unwrap();
        assert_eq!(r.deleted, 1);
        assert_eq!(count(&conn).unwrap(), 0);
        assert_eq!(index::stats(&conn).unwrap().0, 0, "对应文档应一并删除");
    }

    #[test]
    fn unknown_type_falls_back_instead_of_failing() {
        let conn = db();
        apply(&conn, &[cand("add", "瞎编的类型", "t", "内容")], None, &[]).unwrap();
        assert_eq!(list(&conn, None).unwrap()[0].mem_type, "preference");
    }

    #[test]
    fn unknown_op_is_rejected() {
        let conn = db();
        let e = apply(&conn, &[cand("upsert", "event", "t", "x")], None, &[]);
        assert!(e.is_err(), "只允许 add/update/delete，其余应报错而不是静默丢弃");
    }

    #[test]
    fn empty_content_is_not_stored() {
        let conn = db();
        let r = apply(&conn, &[cand("add", "event", "t", "   ")], None, &[]).unwrap();
        assert_eq!((r.added, r.skipped), (0, 1));
        assert_eq!(count(&conn).unwrap(), 0);
    }

    #[test]
    fn cognition_is_formatted_and_capped() {
        let conn = db();
        for i in 0..40 {
            apply(
                &conn,
                &[cand("add", "preference", "饮食", &format!("偏好编号 {i} 的内容"))],
                None,
                &[],
            )
            .unwrap();
        }
        let c = cognition(&conn, None).unwrap();
        assert!(c.memories.len() <= COGNITION_LIMIT);
        assert!(c.text.chars().count() <= COGNITION_MAX_CHARS);
        assert!(c.text.contains("[偏好]"), "应带类型标签: {}", c.text);
        // 一行一条，没有多余空行
        assert_eq!(c.text.lines().count(), c.memories.len());
        for line in c.text.lines() {
            assert!(line.starts_with("- ["), "格式不对: {line}");
        }
    }

    #[test]
    fn cognition_is_empty_when_no_memories() {
        let conn = db();
        let c = cognition(&conn, None).unwrap();
        assert!(c.memories.is_empty());
        assert_eq!(c.text, "");
    }

    #[test]
    fn active_count_drives_cognition_order() {
        let conn = db();
        apply(&conn, &[cand("add", "preference", "a", "第一条")], None, &[]).unwrap();
        apply(&conn, &[cand("add", "preference", "b", "第二条")], None, &[]).unwrap();
        let ids: Vec<i64> = list(&conn, None).unwrap().iter().map(|m| m.id).collect();
        // 把较早那条标记为常用
        bump_active(&conn, &[ids[1]]).unwrap();
        let c = cognition(&conn, None).unwrap();
        assert_eq!(c.memories[0].id, ids[1], "常用记忆应排在前面");
    }

    #[test]
    fn apply_records_an_audit_diff() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "训练", "换了动作")], Some("c9"), &[]).unwrap();
        let Some((at, ops)) = last_diff(&conn).unwrap() else {
            panic!("应写入一条审计记录");
        };
        assert!(!at.is_empty());
        let v: serde_json::Value = serde_json::from_str(&ops).unwrap();
        assert_eq!(v["added"], 1);
        assert_eq!(v["candidates"], 1);
    }

    #[test]
    fn list_can_filter_by_type() {
        let conn = db();
        apply(&conn, &[cand("add", "preference", "a", "偏好一")], None, &[]).unwrap();
        apply(&conn, &[cand("add", "constraint", "b", "约束一")], None, &[]).unwrap();
        assert_eq!(list(&conn, Some("constraint")).unwrap().len(), 1);
        assert_eq!(list(&conn, None).unwrap().len(), 2);
    }
}
