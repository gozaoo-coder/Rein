//! 知识库域命令 · 命令名与前端 `src/services/kbService.ts` 对应。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, State};

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::models::{
    KbChunk, KbCognition, KbDocDetail, KbFile, KbFileInput, KbFsMove, KbFsMoveResult, KbGlobHit,
    KbHit, KbInjection, KbMedia, KbMediaInput, KbMemory, KbMemoryStats, KbQuery, KbSettings,
    KbSettingsInput, KbStatus, MemoryApplyResult, MemoryCandidate, MemoryMaintainResult,
    MODE_KEYWORD,
};
use super::worker::{self, KbHub};
use super::{assets, chunk, embed, files, governance, index, injection, memory, search, settings};

/// 检索前的刷新预算。嵌入是毫秒级，正常一轮就够；超时也不阻塞工具调用。
const REFRESH_BUDGET: Duration = Duration::from_millis(1500);

/// 应用数据目录 = 模态本体的根（workspace/media 与语音 wav 都在它下面）。
fn data_root(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| ReinError::Message(format!("无法定位应用数据目录：{e}")))
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

#[tauri::command]
pub fn kb_status(state: State<AppState>, hub: State<'_, Arc<KbHub>>) -> Result<KbStatus> {
    let conn = state.db.lock().unwrap();
    let s = settings::get(&conn)?;
    let enabled = settings::enabled_sources(&conn)?;
    let (docs, chunks, vectors) = index::stats(&conn)?;
    let vec_model = index::active_vec_model(&conn)?;
    drop(conn);

    // keyword 模式天然就绪（不需要任何外部依赖）；其余模式看是否已报错降级
    let last_error = hub.last_error().or(s.last_error.clone());
    let embedder_ready = s.embedding_mode == MODE_KEYWORD || last_error.is_none();

    Ok(KbStatus {
        mode: s.embedding_mode.clone(),
        docs,
        chunks,
        vectors,
        pending: hub.pending(),
        indexing: hub.is_indexing(),
        progress: hub.progress(),
        last_error,
        embedder_ready,
        vec_model,
        enabled_sources: enabled,
    })
}

/// 混合检索：结构化过滤 + FTS5 + 向量召回 → RRF。
#[tauri::command]
pub fn kb_search(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    query: KbQuery,
) -> Result<Vec<KbHit>> {
    if query.query.trim().is_empty() {
        // 空查询 = 浏览最近内容，而不是报错
        let conn = state.db.lock().unwrap();
        let enabled = settings::enabled_sources(&conn)?;
        return search::browse(&conn, &query, &enabled);
    }

    // 先把积压的脏标记刷掉，保证 AI 看不到陈旧数据
    worker::drain_before_query(&app, REFRESH_BUDGET)?;

    // 读配置（持锁）
    let (enabled, cfg) = {
        let conn = state.db.lock().unwrap();
        (
            settings::enabled_sources(&conn)?,
            embed::resolve_config(&conn)?,
        )
    };

    // 构建 embedder + 嵌入查询串（**不持锁**：首次构建要加载模型）
    let model_id = embed::model_id_of(&cfg);
    let query_vec: Option<Vec<f32>> = match (&cfg.mode[..], &model_id) {
        (MODE_KEYWORD, _) | (_, None) => None,
        _ => match hub.embedder(&cfg)? {
            Some(e) => {
                // 直接采用返回的实际维度，不与 e.dim() 比较：
                // 云端模型的维度常常未知（配置里没填 dim），以返回值为准才不会把云端模式
                // 误降级成关键词。维度混库的安全性由 vector_recall 保证（长度不符即跳过）。
                let v = e.embed(std::slice::from_ref(&query.query))?.into_iter().next();
                Some(v).flatten().filter(|x| !x.is_empty())
            }
            None => None,
        },
    };

    // 检索（持锁）
    let conn = state.db.lock().unwrap();
    search::search(
        &conn,
        &query,
        &enabled,
        query_vec.as_deref(),
        model_id.as_deref(),
    )
}

/// 分层读取。`l1` 只给摘要 + 首块（概览），`l2` 给全部分块正文。
/// 默认 l1——AI 需要细节时应显式要 l2，避免工具结果撑爆上下文。
#[tauri::command]
pub fn kb_read(
    app: AppHandle,
    state: State<AppState>,
    doc_id: i64,
    level: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<KbDocDetail> {
    // 刚写入的笔记/归档文档要能立刻被读到
    worker::drain_before_query(&app, REFRESH_BUDGET)?;
    let conn = state.db.lock().unwrap();
    read_detail(
        &conn,
        doc_id,
        &level.unwrap_or_else(|| "l1".into()),
        offset,
        limit,
    )
}

/// kb_read 的核心。拆出来是为了能直接对内存库做单元测试。
pub fn read_detail(
    conn: &rusqlite::Connection,
    doc_id: i64,
    level: &str,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<KbDocDetail> {
    if level != "l1" && level != "l2" {
        return Err(ReinError::Message(format!(
            "level 只支持 l1 或 l2，收到：{level}"
        )));
    }

    let row = conn
        .query_row(
            "SELECT source_type, source_id, title, summary, occurred_on, tags, meta_json, updated_at,
                    path, editable, system, kind
             FROM kb_docs WHERE id = ?1",
            [doc_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, String>(11)?,
                ))
            },
        )
        .optional()?;
    let Some((
        source_type,
        source_id,
        title,
        summary,
        occurred_on,
        tags,
        meta_json,
        updated_at,
        path,
        editable,
        system,
        kind,
    )) = row
    else {
        return Err(ReinError::Message(format!(
            "知识库条目不存在：id={doc_id}（先用 search_knowledge 查 id）"
        )));
    };

    // note 源（笔记 / 上传文档全文归档）的真源在 kb_files，kb_docs.body 只是带
    // MAX_BODY 上限的检索缓存。阅读必须给全文：否则超过缓存上限的文档被截断后，
    // AI 按页读到头的也只是残篇，「继续读」无路可走。这里对 note 直读真源、
    // 按同一分块参数即时切块；其他源维持 kb_chunks（派生文档本就以缓存为准）。
    let full_chunks: Option<Vec<String>> = if source_type == "note" {
        source_id
            .parse::<i64>()
            .ok()
            .and_then(|fid| {
                conn.query_row("SELECT content FROM kb_files WHERE id = ?1", [fid], |r| {
                    r.get::<_, String>(0)
                })
                .optional()
                .ok()
                .flatten()
            })
            .map(|content| {
                chunk::chunk_text(&content, chunk::DEFAULT_MAX_CHARS, chunk::DEFAULT_OVERLAP)
            })
    } else {
        None
    };

    let (total_chunks, chunks) = match &full_chunks {
        Some(all) => {
            let offset = if level == "l1" {
                0
            } else {
                offset.unwrap_or(0).max(0)
            };
            let limit = if level == "l1" {
                1
            } else {
                limit.unwrap_or(8).clamp(1, 64)
            };
            let start = (offset as usize).min(all.len());
            let end = (start + limit as usize).min(all.len());
            let chunks = all[start..end]
                .iter()
                .enumerate()
                .map(|(k, text)| KbChunk {
                    // 即时切块没有行 id，用块序当 id（对调用方只要求响应内唯一）
                    id: (start + k) as i64,
                    ord: (start + k) as i64,
                    text: text.clone(),
                })
                .collect();
            (all.len() as i64, chunks)
        }
        None => {
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM kb_chunks WHERE doc_id = ?1",
                [doc_id],
                |r| r.get(0),
            )?;
            // l1 固定给首块（概览）；l2 按 offset/limit 分页（docs/kb-vfs.md §3）。
            // l2 默认 8 块 ≈ 2400 字，模型逐页读比一次性倾倒 64 块更可控。
            let offset = if level == "l1" {
                0
            } else {
                offset.unwrap_or(0).max(0)
            };
            let limit = if level == "l1" {
                1
            } else {
                limit.unwrap_or(8).clamp(1, 64)
            };
            let mut stmt = conn.prepare(
                "SELECT id, ord, text FROM kb_chunks WHERE doc_id = ?1 ORDER BY ord LIMIT ?2 OFFSET ?3",
            )?;
            let chunks: Vec<KbChunk> = stmt
                .query_map(rusqlite::params![doc_id, limit, offset], |r| {
                    Ok(KbChunk {
                        id: r.get(0)?,
                        ord: r.get(1)?,
                        text: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (total, chunks)
        }
    };

    let returned = chunks.len() as i64;
    let offset = if level == "l1" {
        0
    } else {
        offset.unwrap_or(0).max(0)
    };
    // 模态清单：文本恒有（有正文/块）；音频/视频/图片等本体见 assets（§2.2）
    let text_chars = match &full_chunks {
        Some(all) => all.iter().map(|s| s.chars().count()).sum::<usize>() as i64,
        None => i64::from(total_chunks > 0),
    };
    let modalities: Vec<String> =
        assets::modals_for_source(conn, None, &source_type, &source_id, text_chars)?
            .into_iter()
            .map(|m| m.modal)
            .collect();
    Ok(KbDocDetail {
        id: doc_id,
        source_type,
        source_id,
        path,
        editable: editable != 0,
        system: system != 0,
        kind,
        title,
        summary,
        occurred_on,
        tags: parse_tags(&tags),
        meta: serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null),
        updated_at,
        level: level.to_string(),
        total_chunks,
        offset,
        has_more: offset + returned < total_chunks,
        chunks,
        modalities,
    })
}

/// 全量对账：把现有源记录重新入队，并清掉孤儿文档。
/// 返回入队条数。老库升级后、或怀疑索引不一致时用。
#[tauri::command]
pub fn kb_reindex(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    sources: Option<Vec<String>>,
) -> Result<i64> {
    let n = {
        let conn = state.db.lock().unwrap();
        let enabled = match sources.filter(|s| !s.is_empty()) {
            Some(s) => s,
            None => settings::enabled_sources(&conn)?,
        };
        index::scan_all(&conn, &enabled)?
    };
    hub.notify();
    Ok(n)
}

#[tauri::command]
pub fn kb_settings_get(state: State<AppState>) -> Result<KbSettings> {
    let conn = state.db.lock().unwrap();
    settings::get(&conn)
}

/// 改设置。模式变化会清空向量，让下一轮索引按新模型重算。
#[tauri::command]
pub fn kb_settings_set(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    input: KbSettingsInput,
) -> Result<KbSettings> {
    let out = {
        let conn = state.db.lock().unwrap();
        let before = settings::get(&conn)?.embedding_mode;
        let after = settings::update(&conn, &input)?;
        if before != after.embedding_mode {
            // 换模式就作废旧向量：留着会让旧模型的向量被当成新模型的复用，检索结果静默错乱。
            // 清空后 chunks_needing_vectors 自然会把所有块重新入列，无需额外标记。
            index::clear_vectors(&conn, None)?;
        }
        after
    };

    // 模式变了要丢掉缓存的 embedder，让下次用新配置重建
    hub.release_embedder();
    hub.notify();
    Ok(out)
}

/// 嵌入后端自检：嵌一句话并校验维度。UI 的「测试连接」按钮用它。
#[tauri::command]
pub fn kb_probe_embedder(state: State<AppState>, hub: State<'_, Arc<KbHub>>) -> Result<usize> {
    let cfg = {
        let conn = state.db.lock().unwrap();
        embed::resolve_config(&conn)?
    };
    if cfg.mode == MODE_KEYWORD {
        return Err(ReinError::Message(
            "当前是纯关键词模式，没有可测试的嵌入后端".into(),
        ));
    }
    let e = hub
        .embedder(&cfg)?
        .ok_or_else(|| ReinError::Message("嵌入后端不可用（检查配置或模型是否就绪）".into()))?;
    e.probe()
}

/// 清空全部向量，触发按当前模型重算（切换模型或修复索引用）。
#[tauri::command]
pub fn kb_rebuild_vectors(state: State<AppState>, hub: State<'_, Arc<KbHub>>) -> Result<usize> {
    let cleared = {
        let conn = state.db.lock().unwrap();
        index::clear_vectors(&conn, None)?
    };
    hub.release_embedder();
    hub.notify();
    Ok(cleared)
}

/* ---------- 记忆层 ---------- */

/// 记忆列表。`scope`: active（默认，仅活跃）/ archived（仅归档）/ all（两者）。
#[tauri::command]
pub fn kb_memories(
    state: State<AppState>,
    mem_type: Option<String>,
    scope: Option<String>,
) -> Result<Vec<KbMemory>> {
    let conn = state.db.lock().unwrap();
    memory::list(
        &conn,
        mem_type.as_deref(),
        memory::parse_scope(scope.as_deref()),
    )
}

/// 落库一次记忆抽取的结果。前端（pi-ai）负责调模型产出 candidates。
#[tauri::command]
pub fn kb_memory_apply(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    candidates: Vec<MemoryCandidate>,
    chat_id: Option<String>,
    message_ids: Option<Vec<String>>,
) -> Result<MemoryApplyResult> {
    let ids = message_ids.unwrap_or_default();
    let out = {
        let conn = state.db.lock().unwrap();
        memory::apply(&conn, &candidates, chat_id.as_deref(), &ids)?
    };
    // 新记忆要尽快可检索，也要尽快进入 prompt 注入块
    hub.notify();
    Ok(out)
}

#[tauri::command]
pub fn kb_memory_delete(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock().unwrap();
        memory::delete(&conn, id)?
    };
    hub.notify();
    Ok(ok)
}

/// 归档一条记忆（软删除，可恢复）。UI 的手动整理与后续自动化都用它。
#[tauri::command]
pub fn kb_memory_archive(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    reason: Option<String>,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock().unwrap();
        memory::archive(&conn, id, reason.as_deref().unwrap_or(""))
    };
    hub.notify();
    ok
}

/// 恢复一条已归档记忆。
#[tauri::command]
pub fn kb_memory_restore(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock().unwrap();
        memory::restore(&conn, id)?
    };
    hub.notify();
    Ok(ok)
}

/// 立即跑一次本地维护（衰减 + 自动归档）。后台线程也会定期跑。
#[tauri::command]
pub fn kb_memory_maintain(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
) -> Result<MemoryMaintainResult> {
    let out = {
        let conn = state.db.lock().unwrap();
        memory::maintain(&conn)?
    };
    hub.notify();
    Ok(out)
}

/// 记忆库信噪比概况（注入覆盖率 / 噪声占比 / 归档数 / 上次整理时间）。
#[tauri::command]
pub fn kb_memory_stats(state: State<AppState>) -> Result<KbMemoryStats> {
    let conn = state.db.lock().unwrap();
    memory::stats(&conn)
}

/// 上报「刚完成一次 LLM 整理」，用于周期任务的节流（每天最多一次）。
#[tauri::command]
pub fn kb_memory_consolidated(state: State<AppState>) -> Result<()> {
    let conn = state.db.lock().unwrap();
    memory::mark_consolidated(&conn)
}

/// 喂给系统提示词的紧凑认知块。前端在每轮请求前取一次（带短 TTL 缓存）。
#[tauri::command]
pub fn kb_cognition(state: State<AppState>) -> Result<KbCognition> {
    let conn = state.db.lock().unwrap();
    memory::cognition(&conn, None)
}

/// 上报「这些记忆被注入了」——注入即用到，用于后续排序。
#[tauri::command]
pub fn kb_memory_bump(state: State<AppState>, ids: Vec<i64>) -> Result<()> {
    let conn = state.db.lock().unwrap();
    memory::bump_active(&conn, &ids)
}

/* ---------- 虚拟文件系统（glob / 真实文件） ---------- */

/// 按路径模式列文档： 不跨目录、 跨目录、 单字符。
///  列笔记、 列全部对话内容、 列全部附件编目。
#[tauri::command]
pub fn kb_glob(
    app: AppHandle,
    state: State<AppState>,
    pattern: String,
    limit: Option<i64>,
) -> Result<Vec<KbGlobHit>> {
    worker::drain_before_query(&app, REFRESH_BUDGET)?;
    let conn = state.db.lock().unwrap();
    search::glob(&conn, &pattern, limit.unwrap_or(100))
}

/// 新建或覆盖一个笔记（内容真源在 kb_files，随后自动进检索编目）。
#[tauri::command]
pub fn kb_file_write(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    input: KbFileInput,
) -> Result<KbFile> {
    let id = {
        let conn = state.db.lock().unwrap();
        files::write(&conn, &input.path, &input.content)?
    };
    hub.notify();
    let conn = state.db.lock().unwrap();
    files::get(&conn, id)
}

/// 笔记改名 / 移动（系统文件拒绝）。
#[tauri::command]
pub fn kb_file_rename(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    path: String,
) -> Result<KbFile> {
    {
        let conn = state.db.lock().unwrap();
        files::rename(&conn, id, &path)?;
    }
    hub.notify();
    let conn = state.db.lock().unwrap();
    files::get(&conn, id)
}

/// 删除文件节点（系统文件拒绝）。本体文件一并从磁盘清掉。
#[tauri::command]
pub fn kb_file_delete(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<()> {
    let refs = {
        let conn = state.db.lock().unwrap();
        files::delete(&conn, id)?
    };
    if let Ok(root) = data_root(&app) {
        for rel in refs {
            let _ = std::fs::remove_file(root.join(rel));
        }
    }
    hub.notify();
    Ok(())
}

/// 取文件原文（编辑器用）。kb_read 走分块管线会丢原始换行，编辑必须拿原文。
#[tauri::command]
pub fn kb_file_get(state: State<AppState>, id: i64) -> Result<KbFile> {
    let conn = state.db.lock().unwrap();
    files::get(&conn, id)
}

/* ---------- 模态层（docs/ai-workspace.md §2） ---------- */

/// 上传/产出一个多模态节点：本体落盘 + 文本模态入索引。
#[tauri::command]
pub fn kb_media_write(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    input: KbMediaInput,
) -> Result<KbFile> {
    let root = data_root(&app)?;
    let id = {
        let conn = state.db.lock().unwrap();
        assets::write_media(&conn, &root, &input)?
    };
    hub.notify();
    let conn = state.db.lock().unwrap();
    files::get(&conn, id)
}

/// 读一次模态：给了 `modal` 就取本体（不可用则降级为文本并说明原因），不给只回清单。
#[tauri::command]
pub fn kb_media_get(
    app: AppHandle,
    state: State<AppState>,
    doc_id: i64,
    modal: Option<String>,
) -> Result<KbMedia> {
    let root = data_root(&app)?;
    let conn = state.db.lock().unwrap();
    assets::read(&conn, &root, doc_id, modal.as_deref())
}

/* ---------- 目录治理（§3.3） ---------- */

/// 把文件移进目标目录（分类）。`source` ∈ ai | user；AI 移动有防抖与 pin 保护。
#[tauri::command]
pub fn kb_fs_move(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    to_dir: String,
    reason: Option<String>,
    source: Option<String>,
) -> Result<KbFsMoveResult> {
    let src = source.unwrap_or_else(|| "user".into());
    let (out, file) = {
        let conn = state.db.lock().unwrap();
        let out = governance::move_to(&conn, id, &to_dir, reason.as_deref().unwrap_or(""), &src)?;
        let fid = conn
            .query_row("SELECT id FROM kb_files WHERE path = ?1", [&out.to], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(id);
        let file = files::get(&conn, fid)?;
        (out, file)
    };
    hub.notify();
    Ok(KbFsMoveResult {
        file,
        from: out.from,
        to: out.to,
        batch_id: out.batch_id,
    })
}

/// 建目录（空目录也会在文件树里可见）。
#[tauri::command]
pub fn kb_fs_mkdir(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    path: String,
    reason: Option<String>,
    source: Option<String>,
) -> Result<KbFile> {
    let src = source.unwrap_or_else(|| "user".into());
    let p = {
        let conn = state.db.lock().unwrap();
        governance::mkdir(&conn, &path, reason.as_deref().unwrap_or(""), &src)?
    };
    hub.notify();
    let conn = state.db.lock().unwrap();
    files::get(&conn, resolve_path(&conn, &p)?)
}

/// 钉住 / 取消钉住。钉住后 AI 的自动整理不会移动它。
#[tauri::command]
pub fn kb_fs_pin(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    pinned: bool,
    source: Option<String>,
) -> Result<KbFile> {
    let src = source.unwrap_or_else(|| "user".into());
    let fid = {
        let conn = state.db.lock().unwrap();
        let path = governance::pin(&conn, id, pinned, &src)?;
        resolve_path(&conn, &path)?
    };
    hub.notify();
    let conn = state.db.lock().unwrap();
    files::get(&conn, fid)
}

fn resolve_path(conn: &rusqlite::Connection, path: &str) -> Result<i64> {
    conn.query_row("SELECT id FROM kb_files WHERE path = ?1", [path], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or_else(|| ReinError::Message(format!("文件不存在：{path}")))
}

/// 整理审计流水（最近的在前）。
#[tauri::command]
pub fn kb_fs_moves(state: State<AppState>, limit: Option<i64>) -> Result<Vec<KbFsMove>> {
    let conn = state.db.lock().unwrap();
    governance::moves(&conn, limit.unwrap_or(50))
}

/// 整批撤销一批整理（按审计里的 batchId）。返回撤销条数。
#[tauri::command]
pub fn kb_fs_undo(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    batch_id: String,
) -> Result<i64> {
    let n = {
        let conn = state.db.lock().unwrap();
        governance::undo(&conn, &batch_id)?
    };
    hub.notify();
    Ok(n)
}

/* ---------- 全量注入区（§3.4） ---------- */

/// 取「系统提示词 + 用户记忆」注入块。前端每轮对话前取一次（带 mtime 缓存）。
#[tauri::command]
pub fn kb_injection_get(state: State<AppState>) -> Result<KbInjection> {
    let conn = state.db.lock().unwrap();
    injection::build(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn note_doc_id(conn: &rusqlite::Connection, file_id: i64) -> i64 {
        conn.query_row(
            "SELECT id FROM kb_docs WHERE source_type = 'note' AND source_id = ?1",
            [file_id.to_string()],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 核心回归：超过 MAX_BODY（8000 字）缓存上限的 note 文档，分页阅读必须能读到
    /// 真源结尾，而不是在缓存截断处就 has_more=false。
    #[test]
    fn note_read_pages_through_full_source_beyond_cache_cap() {
        let conn = db();
        // 结尾标记刻意不含句读——切块只落在句读处，整句才会完整出现在同一块里
        let tail = "全文结尾标记段必须能到达这里";
        // ~21000 字，远超 kb_docs.body 的 8000 字缓存上限
        let mut content = "深蹲注意膝盖不要内扣。".repeat(3000);
        content.push_str(tail);
        let fid = files::write(&conn, "笔记/超长笔记.md", &content).unwrap();
        index::apply_one(&conn, "note", &fid.to_string()).unwrap();
        let doc_id = note_doc_id(&conn, fid);

        // 缓存确实被截断了（这正是要绕开的坑）
        let cached: i64 = conn
            .query_row(
                "SELECT LENGTH(body) FROM kb_docs WHERE id = ?1",
                [doc_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(cached < content.chars().count() as i64, "缓存应有截断上限");

        let first = read_detail(&conn, doc_id, "l2", Some(0), Some(8)).unwrap();
        assert!(
            first.total_chunks > cached as i64 / 300,
            "总块数应按真源算，而非缓存"
        );
        assert!(first.has_more);

        // 一路翻到最后一页，必须能读到真源的结尾标记
        let mut offset = 0i64;
        let mut saw_tail = false;
        loop {
            let page = read_detail(&conn, doc_id, "l2", Some(offset), Some(64)).unwrap();
            assert_eq!(page.offset, offset);
            if page.chunks.is_empty() {
                break;
            }
            saw_tail |= page.chunks.iter().any(|c| c.text.contains(tail));
            if !page.has_more {
                break;
            }
            offset = page.offset + page.chunks.len() as i64;
        }
        assert!(saw_tail, "分页阅读必须覆盖真源全文，包括缓存截断后的结尾");
    }

    #[test]
    fn note_l1_returns_first_chunk_and_full_total() {
        let conn = db();
        let content = "甲".repeat(5000);
        let fid = files::write(&conn, "文档/归档全文.md", &content).unwrap();
        index::apply_one(&conn, "note", &fid.to_string()).unwrap();
        let doc_id = note_doc_id(&conn, fid);

        let d = read_detail(&conn, doc_id, "l1", None, None).unwrap();
        assert_eq!(d.level, "l1");
        assert_eq!(d.offset, 0);
        assert_eq!(d.chunks.len(), 1);
        // 总块数按真源即时切块算，与「整篇一次切完」完全一致
        let expected =
            chunk::chunk_text(&content, chunk::DEFAULT_MAX_CHARS, chunk::DEFAULT_OVERLAP).len();
        assert_eq!(d.total_chunks as usize, expected);
        // l1 的 has_more 语义与派生文档一致：首块之外还有正文
        assert!(d.has_more);
    }

    /// 派生文档（memory 为例）保持原行为：块与 has_more 都来自 kb_chunks。
    #[test]
    fn derived_doc_read_unchanged() {
        let conn = db();
        memory::apply(
            &conn,
            &[MemoryCandidate {
                op: "add".into(),
                id: None,
                mem_type: "preference".into(),
                topic: "训练偏好".into(),
                category: String::new(),
                content: "用户偏好晨练，避免深蹲超过 60 公斤。".into(),
                confidence: Some(0.9),
                reason: String::new(),
            }],
            None,
            &[],
        )
        .unwrap();
        let mem_id: i64 = conn
            .query_row("SELECT id FROM kb_memories LIMIT 1", [], |r| r.get(0))
            .unwrap();
        index::apply_one(&conn, "memory", &mem_id.to_string()).unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM kb_docs WHERE source_type = 'memory' AND source_id = ?1",
                [mem_id.to_string()],
                |r| r.get(0),
            )
            .unwrap();

        let d = read_detail(&conn, doc_id, "l2", Some(0), Some(8)).unwrap();
        assert_eq!(d.chunks.len(), 1, "短记忆应只有一块");
        assert!(d.chunks[0].text.contains("晨练"));
        assert!(!d.has_more);
        assert!(d.editable, "记忆是可编辑的派生文档");
    }
}
