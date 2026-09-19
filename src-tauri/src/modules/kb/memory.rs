//! 长期记忆：AI 从对话中提炼的「对用户的认知」，以及喂给系统提示词的那一小段文字。
//!
//! 编排在**前端**（模型调用由 WebView 里的 pi-ai 直连 provider，Rust 不调模型，见 modules/ai/mod.rs）。
//! 前端把「会话消息 + 现有记忆清单」交给模型，模型返回严格 JSON 的增/改/删，再调 `kb_memory_apply`
//! 落到这里。把「抽取」与「去重决策」压成**一次**模型调用（让模型看到现有记忆后直接给出合并结果），
//! 比 OpenViking 的「抽取 + 向量预筛 + LLM 去重」两轮省一半成本。
//!
//! 记忆不是独立系统：它是 kb_docs 的一类来源（source_type='memory'），所以天然进入同一套检索与召回。
//!
//! **生命周期**（对齐「记忆会淡忘」的直觉，而不是只增不减的日志）：
//!
//! - 排序不再是「三列硬拼」，而是连续分数 **显著性** = 置信度 × 时间衰减 × 使用强化
//!   （[`salience_of`]）。被注入一次就刷新计时，两周不用分数减半。
//! - [`maintain`] 定期把长期闲置且低显著性的记忆**归档**（软删除）：退出注入与检索两条链路，
//!   但仍在库里可恢复；再次被提及（update / 重复 add）会自动复活（见 [`apply`]）。
//! - [`stats`] 给出显式的信噪比指标：注入覆盖率与低显著性占比，供 UI 与用户判断要不要整理。
//! - 更重的「做梦」式整理（LLM 合并重叠、统一分类、校准置信度、主动归档噪声）编排在前端
//!   （src/ai/memoryConsolidate.ts），落库走同一条 [`apply`]。

use rusqlite::{Connection, OptionalExtension};
use serde_json::json;

use crate::error::{ReinError, Result};

use super::index;
use super::models::{
    KbCognition, KbMemory, KbMemoryStats, MemoryApplyResult, MemoryCandidate, MemoryMaintainResult,
    MEMORY_TYPES,
};
use super::source::mem_type_label;

/// 注入 prompt 的记忆条数上限。每轮都要进系统提示词，必须克制。
const COGNITION_LIMIT: usize = 24;
/// 注入块的总字符上限，兜底防止单条超长记忆把提示词撑起来。
const COGNITION_MAX_CHARS: usize = 1200;
/// 显著性半衰期（天）：闲置两周，显著性减半；被注入一次就重新计时。
const SALIENCE_HALF_LIFE_DAYS: f64 = 14.0;
/// 显著性低于此值视为「低信号」，参与信噪比统计与自动归档判定。
pub const STALE_SALIENCE: f64 = 0.15;
/// 从未被注入过（active_count = 0）、且闲置超过这个天数 → 归档。
/// 新记忆在第一次注入前不该被误伤，所以这条只对「陈年未用」生效。
const NEVER_USED_PRUNE_DAYS: f64 = 30.0;
/// 显著性已跌破阈值、且闲置超过这个天数 → 归档。
const STALE_PRUNE_DAYS: f64 = 45.0;
/// 自动归档的原因标记（见 kb_memories.archived_reason）。
const ARCHIVE_REASON_DECAY: &str = "decay";
/// 手动归档（UI 按钮）未给原因时的兜底标记。
const ARCHIVE_REASON_MANUAL: &str = "manual";

const COLS: &str = "id, mem_type, topic, category, content, confidence, active_count, source_chat_id, \
                    created_at, updated_at, last_used_at, archived_at, archived_reason";
/// 「闲置天数」：优先看最近一次被注入，其次看最后修改/创建。SQL 里算，避免引入时间库。
const IDLE_DAYS_SQL: &str =
    "(julianday('now') - julianday(COALESCE(last_used_at, updated_at, created_at)))";

/// 记忆列表的视角：活跃 / 已归档 / 全部。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryScope {
    Active,
    Archived,
    All,
}

/// 解析命令层传来的 scope 字符串，未知值收敛到 Active（最安全的默认）。
pub fn parse_scope(raw: Option<&str>) -> MemoryScope {
    match raw.map(str::trim) {
        Some("all") => MemoryScope::All,
        Some("archived") => MemoryScope::Archived,
        _ => MemoryScope::Active,
    }
}

/// 显著性：排序与淘汰共用的连续分数。
///
/// `confidence` 是模型给的把握；`decay` 让久未使用的记忆自然淡出；`reinforcement`
/// 用对数压缩使用次数，避免高频条目碾压一切（10 次使用的加成约 +60%，而不是 ×10）。
pub fn salience_of(confidence: f64, active_count: i64, idle_days: f64) -> f64 {
    let decay = 0.5f64.powf(idle_days.max(0.0) / SALIENCE_HALF_LIFE_DAYS);
    let reinforcement = 1.0 + (1.0 + active_count as f64).ln() / 4.0;
    confidence * decay * reinforcement
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn row_to_memory_with_idle(r: &rusqlite::Row) -> rusqlite::Result<(KbMemory, f64)> {
    let confidence: f64 = r.get(5)?;
    let active_count: i64 = r.get(6)?;
    let idle_days: f64 = r.get(13)?;
    Ok((
        KbMemory {
            id: r.get(0)?,
            mem_type: r.get(1)?,
            topic: r.get(2)?,
            category: r.get(3)?,
            content: r.get(4)?,
            confidence,
            active_count,
            source_chat_id: r.get(7)?,
            created_at: r.get(8)?,
            updated_at: r.get(9)?,
            last_used_at: r.get(10)?,
            archived_at: r.get(11)?,
            archived_reason: r.get(12)?,
            salience: salience_of(confidence, active_count, idle_days),
        },
        idle_days,
    ))
}

fn row_to_memory(r: &rusqlite::Row) -> rusqlite::Result<KbMemory> {
    row_to_memory_with_idle(r).map(|(m, _)| m)
}

/// 全部活跃记忆 + 各自的闲置天数（显著性已算好）。排序与统计共用这一份取数。
fn active_with_idle(conn: &Connection) -> Result<Vec<(KbMemory, f64)>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS}, {IDLE_DAYS_SQL} AS idle_days FROM kb_memories WHERE archived_at IS NULL"
    ))?;
    let rows = stmt
        .query_map([], row_to_memory_with_idle)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list(conn: &Connection, mem_type: Option<&str>, scope: MemoryScope) -> Result<Vec<KbMemory>> {
    let mut sql = format!("SELECT {COLS}, {IDLE_DAYS_SQL} AS idle_days FROM kb_memories WHERE 1=1");
    let mut binds: Vec<String> = Vec::new();
    if let Some(t) = mem_type.filter(|t| !t.is_empty()) {
        sql.push_str(" AND mem_type = ?1");
        binds.push(t.to_string());
    }
    match scope {
        MemoryScope::Active => sql.push_str(" AND archived_at IS NULL"),
        MemoryScope::Archived => sql.push_str(" AND archived_at IS NOT NULL"),
        MemoryScope::All => {}
    }
    // 活跃永远排在归档前面；组内按最近修改
    sql.push_str(" ORDER BY (archived_at IS NOT NULL), updated_at DESC, id DESC");

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

/// 分类路径规范化：按 `/` 分层，逐段净化，最多两层、每段 ≤ 16 字。
/// 与虚拟路径共用同一套净化规则（source::sanitize），保证 `记忆/{类型}/{分类}/…` 永远合法。
pub fn normalize_category(raw: &str) -> String {
    raw.split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .take(2)
        .map(|s| super::source::sanitize(s, 16))
        .collect::<Vec<_>>()
        .join("/")
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
        archived: 0,
        restored: 0,
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
                let category = normalize_category(&c.category);
                let n = tx.execute(
                    "INSERT OR IGNORE INTO kb_memories(mem_type, topic, category, content, confidence,
                            source_chat_id, source_message_ids, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))",
                    rusqlite::params![
                        mem_type,
                        topic,
                        category,
                        content,
                        c.confidence.unwrap_or(0.7),
                        chat_id,
                        src_ids,
                    ],
                )?;
                if n == 0 {
                    // UNIQUE(mem_type, topic, content) 命中：同一条记忆被反复抽取是常态。
                    // 但若命中在**已归档**条目上，说明用户又提到了它——复活，而不是让它烂在归档区。
                    let revived = tx.execute(
                        "UPDATE kb_memories SET archived_at = NULL, archived_reason = NULL,
                                updated_at = datetime('now')
                         WHERE mem_type = ?1 AND topic = ?2 AND content = ?3 AND archived_at IS NOT NULL",
                        rusqlite::params![mem_type, topic, content],
                    )?;
                    if revived > 0 {
                        result.restored += 1;
                        let id: i64 = tx.query_row(
                            "SELECT id FROM kb_memories WHERE mem_type = ?1 AND topic = ?2 AND content = ?3",
                            rusqlite::params![mem_type, topic, content],
                            |r| r.get(0),
                        )?;
                        touched.push(id);
                    } else {
                        result.skipped += 1;
                    }
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
                let was_archived: bool = tx
                    .query_row(
                        "SELECT archived_at IS NOT NULL FROM kb_memories WHERE id = ?1",
                        [id],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                    .map(|v| v != 0)
                    .unwrap_or(false);
                let n = tx.execute(
                    "UPDATE kb_memories SET mem_type = ?2, topic = ?3, category = ?4, content = ?5,
                            confidence = ?6, source_message_ids = ?7,
                            archived_at = NULL, archived_reason = NULL, updated_at = datetime('now')
                     WHERE id = ?1",
                    rusqlite::params![
                        id,
                        normalize_type(&c.mem_type),
                        c.topic.trim(),
                        normalize_category(&c.category),
                        content,
                        c.confidence.unwrap_or(0.7),
                        src_ids,
                    ],
                )?;
                if n > 0 {
                    // 更新 = 用户/模型重新确认了这条：归档中的条目借此复活
                    if was_archived {
                        result.restored += 1;
                    } else {
                        result.updated += 1;
                    }
                    touched.push(id);
                } else {
                    result.skipped += 1;
                }
            }
            "archive" => {
                let Some(id) = c.id else {
                    result.skipped += 1;
                    continue;
                };
                if archive_in_tx(&tx, id, c.reason.trim())? {
                    result.archived += 1;
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
                    "记忆操作只支持 add / update / delete / archive，收到：{other}"
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
        rusqlite::params![
            chat_id,
            serde_json::to_string(&json!({
                "candidates": candidates.len(),
                "added": result.added,
                "updated": result.updated,
                "deleted": result.deleted,
                "archived": result.archived,
                "restored": result.restored,
                "skipped": result.skipped,
            }))?
        ],
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

/// 归档一条记忆（软删除）。退出注入与检索，但保留可恢复。
pub fn archive(conn: &Connection, id: i64, reason: &str) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let ok = archive_in_tx(&tx, id, reason.trim())?;
    tx.commit()?;
    Ok(ok)
}

/// 在事务内归档：更新状态 + 摘掉检索文档。归档即同时退出「注入 + 检索」两条链路。
fn archive_in_tx(tx: &rusqlite::Transaction, id: i64, reason: &str) -> Result<bool> {
    let reason = if reason.is_empty() {
        ARCHIVE_REASON_MANUAL
    } else {
        reason
    };
    let n = tx.execute(
        "UPDATE kb_memories SET archived_at = datetime('now'), archived_reason = ?2
         WHERE id = ?1 AND archived_at IS NULL",
        rusqlite::params![id, reason],
    )?;
    if n > 0 {
        index::delete_doc(tx, "memory", &id.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// 恢复一条已归档记忆：重新进入注入与检索范围。
pub fn restore(conn: &Connection, id: i64) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
        "UPDATE kb_memories SET archived_at = NULL, archived_reason = NULL, updated_at = datetime('now')
         WHERE id = ?1 AND archived_at IS NOT NULL",
        [id],
    )?;
    if n > 0 {
        index::mark_dirty(&tx, "memory", &id.to_string())?;
    }
    tx.commit()?;
    Ok(n > 0)
}

/// 定期维护：给长期闲置、低显著性的记忆做自动归档。
///
/// 两条判定，都以「长期闲置」为前提（新记忆不误伤）：
/// 1. 从未被注入过且闲置 > [`NEVER_USED_PRUNE_DAYS`]：抽取噪声或早已无关；
/// 2. 显著性 < [`STALE_SALIENCE`] 且闲置 > [`STALE_PRUNE_DAYS`]：曾经有点用，但已掉出注入窗口很久。
///
/// 归档不是删除——记忆仍在库里（UI 有归档区），再次被提及会自动复活。无模型调用，纯本地判定。
pub fn maintain(conn: &Connection) -> Result<MemoryMaintainResult> {
    let rows = active_with_idle(conn)?;
    let tx = conn.unchecked_transaction()?;
    let mut archived = 0i64;
    for (m, idle_days) in &rows {
        let due = (m.active_count == 0 && *idle_days > NEVER_USED_PRUNE_DAYS)
            || (m.salience < STALE_SALIENCE && *idle_days > STALE_PRUNE_DAYS);
        if !due {
            continue;
        }
        if archive_in_tx(&tx, m.id, ARCHIVE_REASON_DECAY)? {
            archived += 1;
        }
    }
    if archived > 0 {
        tx.execute(
            "INSERT INTO kb_memory_diffs(chat_id, at, ops_json) VALUES (NULL, datetime('now'), ?1)",
            [serde_json::to_string(&json!({
                "maintain": true,
                "checked": rows.len(),
                "archived": archived,
            }))?],
        )?;
    }
    tx.execute(
        "UPDATE kb_settings SET last_maintain_at = datetime('now') WHERE id = 1",
        [],
    )?;
    tx.commit()?;
    Ok(MemoryMaintainResult {
        checked: rows.len() as i64,
        archived,
    })
}

/// 显式的信噪比指标与记忆库概况（UI 面板与整理决策共用）。
///
/// - `signal_ratio`（注入覆盖率）= 当前会被注入的条数 / 活跃条数：记忆库越大、这个数越低，
///   说明大部分记忆根本进不了提示词；
/// - `noise_ratio`（噪声占比）= 显著性低于阈值 / 活跃条数：该整理（合并或归档）的比例。
pub fn stats(conn: &Connection) -> Result<KbMemoryStats> {
    let rows = active_with_idle(conn)?;
    let active = rows.len() as i64;
    let archived: i64 = conn.query_row(
        "SELECT COUNT(*) FROM kb_memories WHERE archived_at IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let stale = rows.iter().filter(|(m, _)| m.salience < STALE_SALIENCE).count() as i64;
    let avg = |f: fn(&KbMemory) -> f64| -> f64 {
        if rows.is_empty() {
            0.0
        } else {
            round3(rows.iter().map(|(m, _)| f(m)).sum::<f64>() / active as f64)
        }
    };
    // 先把平均值算出来，再把 rows 交给注入选择（避免借用与移动冲突）
    let avg_confidence = avg(|m| m.confidence);
    let avg_salience = avg(|m| m.salience);

    let (injected_memories, text) = cognition_selection(rows, COGNITION_LIMIT);
    let injected = injected_memories.len() as i64;

    let (auto_consolidate, last_consolidate_at, last_maintain_at) = conn.query_row(
        "SELECT auto_consolidate, last_consolidate_at, last_maintain_at FROM kb_settings WHERE id = 1",
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)? != 0,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )?;

    Ok(KbMemoryStats {
        active,
        archived,
        total: active + archived,
        limit: COGNITION_LIMIT as i64,
        max_chars: COGNITION_MAX_CHARS as i64,
        injected,
        injected_chars: text.chars().count() as i64,
        stale,
        avg_confidence,
        avg_salience,
        signal_ratio: if active > 0 {
            round3(injected as f64 / active as f64)
        } else {
            1.0
        },
        noise_ratio: if active > 0 {
            round3(stale as f64 / active as f64)
        } else {
            0.0
        },
        auto_consolidate,
        last_consolidate_at,
        last_maintain_at,
    })
}

/// 记下「刚刚做过一次 LLM 整理」，用于前端的周期节流（每天最多一次）。
pub fn mark_consolidated(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE kb_settings SET last_consolidate_at = datetime('now') WHERE id = 1",
        [],
    )?;
    Ok(())
}

/// 构建喂给系统提示词的紧凑认知块。
///
/// 这一段直接进每轮请求，所以排序按**显著性**（置信度 × 衰减 × 使用），并做总量截断；
/// 已归档的记忆永远不进。只做 L0 呈现：一条一行，不带来源与时间戳——模型需要细节时会去调 search_knowledge。
pub fn cognition(conn: &Connection, limit: Option<usize>) -> Result<KbCognition> {
    let rows = active_with_idle(conn)?;
    let (memories, text) = cognition_selection(rows, limit.unwrap_or(COGNITION_LIMIT));
    Ok(KbCognition { memories, text })
}

/// 认知块的一行：`- [类型·分类] 内容`；分类为空时退化为 `- [类型] 内容`。
fn cognition_line(m: &KbMemory) -> String {
    let label = if m.category.is_empty() {
        mem_type_label(&m.mem_type).to_string()
    } else {
        format!("{}·{}", mem_type_label(&m.mem_type), m.category)
    };
    format!("- [{label}] {}", m.content.trim())
}

/// 选出该进注入块的记忆（按显著性降序，条数与字符双上限），并拼出文本。
fn cognition_selection(mut rows: Vec<(KbMemory, f64)>, limit: usize) -> (Vec<KbMemory>, String) {
    rows.sort_by(|a, b| {
        b.0.salience
            .partial_cmp(&a.0.salience)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.id.cmp(&a.0.id))
    });

    let mut memories = Vec::new();
    let mut text = String::new();
    for (m, _) in rows {
        if memories.len() >= limit {
            break;
        }
        let line = cognition_line(&m);
        if text.chars().count() + line.chars().count() + 1 > COGNITION_MAX_CHARS {
            break;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&line);
        memories.push(m);
    }
    (memories, text)
}

/// 记忆被注入后计数并刷新使用时间。注入即「用到了」，衰减重新计时。
pub fn bump_active(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE kb_memories SET active_count = active_count + 1, last_used_at = datetime('now')
             WHERE id = ?1",
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
            category: String::new(),
            content: content.into(),
            confidence: None,
            reason: String::new(),
        }
    }

    fn id_of(conn: &Connection, content: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM kb_memories WHERE content = ?1",
            [content],
            |r| r.get(0),
        )
        .unwrap()
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
        let id: i64 = conn
            .query_row("SELECT id FROM kb_memories", [], |r| r.get(0))
            .unwrap();
        let out = index::apply_one(&conn, "memory", &id.to_string()).unwrap();
        assert!(out.doc_id.is_some());

        let (docs, _, _) = index::stats(&conn).unwrap();
        assert_eq!(docs, 1);
    }

    #[test]
    fn update_changes_content_and_reindexes() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "event", "训练", "上周把深蹲换成腿举")],
            None,
            &[],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM kb_memories", [], |r| r.get(0))
            .unwrap();
        index::apply_one(&conn, "memory", &id.to_string()).unwrap();
        index::take_dirty(&conn, 100).unwrap();

        let mut c = cand("update", "event", "训练", "因为膝盖不适，把深蹲换成了腿举");
        c.id = Some(id);
        let r = apply(&conn, &[c], None, &[]).unwrap();
        assert_eq!(r.updated, 1);
        let m = &list(&conn, None, MemoryScope::Active).unwrap()[0];
        assert!(m.content.contains("膝盖不适"));
        assert_eq!(
            index::pending_count(&conn).unwrap(),
            1,
            "更新后应重新入索引队列"
        );
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
        apply(
            &conn,
            &[cand("add", "preference", "饮食", "不吃辣")],
            None,
            &[],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM kb_memories", [], |r| r.get(0))
            .unwrap();
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
        assert_eq!(list(&conn, None, MemoryScope::Active).unwrap()[0].mem_type, "preference");
    }

    #[test]
    fn unknown_op_is_rejected() {
        let conn = db();
        let e = apply(&conn, &[cand("upsert", "event", "t", "x")], None, &[]);
        assert!(
            e.is_err(),
            "只允许 add/update/delete，其余应报错而不是静默丢弃"
        );
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
                &[cand(
                    "add",
                    "preference",
                    "饮食",
                    &format!("偏好编号 {i} 的内容"),
                )],
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
        apply(
            &conn,
            &[cand("add", "preference", "a", "第一条")],
            None,
            &[],
        )
        .unwrap();
        apply(
            &conn,
            &[cand("add", "preference", "b", "第二条")],
            None,
            &[],
        )
        .unwrap();
        let ids: Vec<i64> = list(&conn, None, MemoryScope::Active).unwrap().iter().map(|m| m.id).collect();
        // 把较早那条标记为常用
        bump_active(&conn, &[ids[1]]).unwrap();
        let c = cognition(&conn, None).unwrap();
        assert_eq!(c.memories[0].id, ids[1], "常用记忆应排在前面");
    }

    #[test]
    fn apply_records_an_audit_diff() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "event", "训练", "换了动作")],
            Some("c9"),
            &[],
        )
        .unwrap();
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
        apply(
            &conn,
            &[cand("add", "preference", "a", "偏好一")],
            None,
            &[],
        )
        .unwrap();
        apply(
            &conn,
            &[cand("add", "constraint", "b", "约束一")],
            None,
            &[],
        )
        .unwrap();
        assert_eq!(
            list(&conn, Some("constraint"), MemoryScope::Active)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(list(&conn, None, MemoryScope::Active).unwrap().len(), 2);
    }

    /// 显著性随时间衰减：60 天没被用到的记忆应远低于新鲜记忆。
    #[test]
    fn salience_decays_with_idle_time() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "preference", "a", "久未使用的旧记忆")],
            None,
            &[],
        )
        .unwrap();
        apply(
            &conn,
            &[cand("add", "preference", "b", "新鲜记忆")],
            None,
            &[],
        )
        .unwrap();
        let old = id_of(&conn, "久未使用的旧记忆");
        conn.execute(
            "UPDATE kb_memories SET last_used_at = datetime('now', '-60 days') WHERE id = ?1",
            [old],
        )
        .unwrap();

        let rows = list(&conn, None, MemoryScope::Active).unwrap();
        let old_s = rows.iter().find(|m| m.id == old).unwrap().salience;
        let new_s = rows
            .iter()
            .find(|m| m.content == "新鲜记忆")
            .unwrap()
            .salience;
        assert!(
            old_s < new_s * 0.08,
            "闲置 60 天（约 4 个半衰期）应衰减到 1/16 以下：{old_s} vs {new_s}"
        );
    }

    /// 自动维护只归档「长期闲置 + 低信号」，新鲜记忆不受影响，且留审计。
    #[test]
    fn maintain_archives_only_stale_never_used() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "event", "训练", "陈年未用的记忆")],
            None,
            &[],
        )
        .unwrap();
        apply(&conn, &[cand("add", "event", "训练", "新鲜记忆")], None, &[]).unwrap();
        let old = id_of(&conn, "陈年未用的记忆");
        conn.execute(
            "UPDATE kb_memories SET created_at = datetime('now', '-40 days'),
                    updated_at = datetime('now', '-40 days') WHERE id = ?1",
            [old],
        )
        .unwrap();

        let r = maintain(&conn).unwrap();
        assert_eq!((r.checked, r.archived), (2, 1));
        assert_eq!(list(&conn, None, MemoryScope::Active).unwrap().len(), 1);
        let archived = list(&conn, None, MemoryScope::Archived).unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, old);
        assert_eq!(archived[0].archived_reason.as_deref(), Some("decay"));

        // 归档即退出注入
        let c = cognition(&conn, None).unwrap();
        assert_eq!(c.memories.len(), 1);
        assert_eq!(c.memories[0].content, "新鲜记忆");

        // 维护留一条审计，并刷新设置页要展示的时间戳
        let (_, ops) = last_diff(&conn).unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&ops).unwrap();
        assert_eq!(v["archived"], 1);
        assert!(stats(&conn).unwrap().last_maintain_at.is_some());
    }

    /// 归档是软删除：restore 后重新回到注入与检索；重复恢复是幂等 no-op。
    #[test]
    fn restore_revives_archived_memory() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "preference", "a", "以后要恢复的记忆")],
            None,
            &[],
        )
        .unwrap();
        let id = id_of(&conn, "以后要恢复的记忆");
        index::apply_one(&conn, "memory", &id.to_string()).unwrap();
        index::take_dirty(&conn, 100).unwrap();
        assert_eq!(index::stats(&conn).unwrap().0, 1);

        assert!(archive(&conn, id, "test").unwrap());
        assert_eq!(index::stats(&conn).unwrap().0, 0, "归档应摘掉检索文档");
        assert!(
            cognition(&conn, None).unwrap().memories.is_empty(),
            "归档后不再注入"
        );

        assert!(restore(&conn, id).unwrap());
        assert_eq!(index::pending_count(&conn).unwrap(), 1, "恢复应重新入索引队列");
        assert_eq!(cognition(&conn, None).unwrap().memories.len(), 1);
        assert!(!restore(&conn, id).unwrap(), "重复恢复应是无害的 no-op");
    }

    /// 重复抽取命中已归档条目 → 复活而不是当作重复跳过。
    #[test]
    fn duplicate_add_revives_archived() {
        let conn = db();
        let c = cand("add", "constraint", "膝盖", "避免深蹲过深");
        apply(&conn, std::slice::from_ref(&c), None, &[]).unwrap();
        let id = id_of(&conn, "避免深蹲过深");
        assert!(archive(&conn, id, "decay").unwrap());
        index::take_dirty(&conn, 100).unwrap();

        let r = apply(&conn, std::slice::from_ref(&c), None, &[]).unwrap();
        assert_eq!((r.added, r.restored, r.skipped), (0, 1, 0));
        let rows = list(&conn, None, MemoryScope::Active).unwrap();
        assert_eq!(rows.len(), 1, "应已复活回活跃区");
        assert!(rows[0].archived_at.is_none());
    }

    /// update 隐含「重新确认」：归档中的条目被更新时自动复活。
    #[test]
    fn update_unarchives() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "训练", "旧描述")], None, &[]).unwrap();
        let id = id_of(&conn, "旧描述");
        archive(&conn, id, "decay").unwrap();

        let mut c = cand("update", "event", "训练", "新描述");
        c.id = Some(id);
        let r = apply(&conn, &[c], None, &[]).unwrap();
        assert_eq!((r.updated, r.restored), (0, 1));
        let rows = list(&conn, None, MemoryScope::Active).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "新描述");
        assert!(rows[0].archived_at.is_none());
    }

    /// archive 操作符（整理任务用）：带原因归档，重复归档幂等跳过。
    #[test]
    fn archive_op_records_reason() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "t", "过时记忆")], None, &[]).unwrap();
        let id = id_of(&conn, "过时记忆");
        let mut c = cand("archive", "", "", "");
        c.id = Some(id);
        c.reason = "outdated".into();

        let r = apply(&conn, std::slice::from_ref(&c), None, &[]).unwrap();
        assert_eq!(r.archived, 1);
        let a = &list(&conn, None, MemoryScope::Archived).unwrap()[0];
        assert_eq!(a.archived_reason.as_deref(), Some("outdated"));

        let r2 = apply(&conn, std::slice::from_ref(&c), None, &[]).unwrap();
        assert_eq!((r2.archived, r2.skipped), (0, 1));
    }

    /// 分类规范化：分层保留、非法字符净化、最多两层。
    #[test]
    fn category_is_normalized() {
        assert_eq!(normalize_category("健康 / 训练"), "健康/训练");
        assert_eq!(normalize_category("a/b/c"), "a/b");
        assert_eq!(normalize_category("   "), "");
        assert_eq!(normalize_category("膝盖:康复"), "膝盖-康复");
    }

    /// 分类进入注入标签，让模型看到记忆的组织方式。
    #[test]
    fn category_shows_in_cognition_line() {
        let conn = db();
        let mut c = cand("add", "constraint", "膝盖", "深蹲不宜超过 60kg");
        c.category = "健康/训练".into();
        apply(&conn, &[c], None, &[]).unwrap();
        let cog = cognition(&conn, None).unwrap();
        assert!(
            cog.text.contains("[约束·健康/训练]"),
            "分类应进入注入标签: {}",
            cog.text
        );
    }

    /// 信噪比统计：注入覆盖率与噪声占比都应是显式数字。
    #[test]
    fn stats_reports_signal_and_noise() {
        let conn = db();
        for i in 0..30 {
            apply(
                &conn,
                &[cand("add", "preference", &format!("t{i}"), &format!("内容 {i}"))],
                None,
                &[],
            )
            .unwrap();
        }
        // 其中 5 条推到 60 天前：显著性跌破阈值，计入噪声
        conn.execute(
            "UPDATE kb_memories SET last_used_at = datetime('now', '-60 days') WHERE id IN (1,2,3,4,5)",
            [],
        )
        .unwrap();

        let s = stats(&conn).unwrap();
        assert_eq!((s.active, s.archived, s.total), (30, 0, 30));
        assert_eq!(s.limit, COGNITION_LIMIT as i64);
        assert_eq!(s.injected, COGNITION_LIMIT as i64, "30 条里只有前 24 条进提示词");
        assert!(s.signal_ratio < 1.0 && s.signal_ratio > 0.0);
        assert_eq!(s.stale, 5);
        assert!((s.noise_ratio - 5.0 / 30.0).abs() < 0.001);
        assert!(s.injected_chars > 0 && s.injected_chars <= COGNITION_MAX_CHARS as i64);
        assert!(s.last_maintain_at.is_none());
    }

    #[test]
    fn mark_consolidated_stamps_settings() {
        let conn = db();
        assert!(stats(&conn).unwrap().last_consolidate_at.is_none());
        mark_consolidated(&conn).unwrap();
        assert!(stats(&conn).unwrap().last_consolidate_at.is_some());
    }
}
