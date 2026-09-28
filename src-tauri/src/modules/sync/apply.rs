//! 应用远端对象：把对端的 `sync_objects` 落回本地业务表。
//!
//! 四件事，按重要程度排：
//!
//! 1. **谁赢**：按 `(hlc, device)` 比大小（LWW）。相等内容直接跳过；两边都改过且内容不同时，
//!    输的那版进 `sync_conflicts` 留档（可回看，**不自动合并** —— 逐字段合并要为每张表写规则，
//!    那是另一个量级的复杂度）。留档这一步是有意的：不合并可以接受，静默丢改动不行。
//! 2. **本地 id 怎么办**：对端的 id 只在对端有意义。应用时先按 uuid 找本地行
//!    （`sync_map`）；没有映射就按业务唯一键找（`body_metrics.date`、`foods.name`、`kb_files.path`
//!    —— 两台设备各自记了同一天体重时靠它并成一条）；都没有才插入，让 SQLite 分配本地 id，
//!    再把 `(kind, 本地 id) → uuid` 记进映射表。
//! 3. **引用怎么落地**：`__ref` 换成目标的本地 id；`__natural` 按业务键在本机找那条
//!    （内置食物两端都有，只是 id 不同）；找不到就**整批留到下一轮**（`Unresolved`）——
//!    绝不猜、也不塞 null 把关系弄丢。
//! 4. **不回声**：应用会触发变更钩子（我们写的就是本地库），所以捕获那一步会比对内容：
//!    与已存对象一模一样就不新增版本、不写复制日志。少了这条，两台设备会互相把对方的
//!    对象原样发回去，永远不收敛。
//!
//! 应用过的远端改动**也追加 `sync_log`**：多设备（A→B→C）靠它转传。

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::Result;

use super::blobs::BlobStore;
use super::media;
use super::tables::{self, Pk};
use super::{meta_get, meta_set};

/// 一条要发出去（或刚收进来）的对象。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteObject {
    pub uuid: String,
    pub kind: String,
    pub hlc: i64,
    pub device: String,
    pub deleted: bool,
    pub blob: String,
}

#[derive(Default, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStats {
    pub applied: usize,
    pub skipped: usize,
    pub conflicts: usize,
    pub unresolved: usize,
    /// 引用解析不了、留到下一轮的对象（uuid）
    pub pending: Vec<String>,
}

/// 从复制日志里取一批待发送的对象（`seq > from_seq`）。
/// 同一 uuid 的多条日志只发最新那条 —— 中间版本没有存在意义。
pub fn outbox(conn: &Connection, from_seq: i64, limit: usize) -> Result<(Vec<RemoteObject>, i64)> {
    let mut stmt = conn.prepare(
        "SELECT l.seq, o.uuid, o.kind, o.hlc, o.device, o.deleted, o.blob \
         FROM sync_log l JOIN sync_objects o ON o.uuid = l.uuid \
         WHERE l.seq > ?1 ORDER BY l.seq LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![from_seq, limit as i64], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            RemoteObject {
                uuid: r.get(1)?,
                kind: r.get(2)?,
                hlc: r.get(3)?,
                device: r.get(4)?,
                deleted: r.get::<_, i64>(5)? != 0,
                blob: r.get(6)?,
            },
        ))
    })?;
    let mut out: Vec<RemoteObject> = Vec::new();
    let mut last_seq = from_seq;
    for row in rows {
        let (seq, obj) = row?;
        last_seq = last_seq.max(seq);
        match out.iter_mut().find(|o| o.uuid == obj.uuid) {
            Some(slot) => *slot = obj,
            None => out.push(obj),
        }
    }
    Ok((out, last_seq))
}

/// 本机已确认的发送进度（每台设备各一份）。
pub fn cursor_sent(conn: &Connection, device: &str) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT last_seq_sent FROM sync_peers WHERE device = ?1",
            [device],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

pub fn set_cursor(conn: &Connection, device: &str, sent: i64, ack: i64) -> Result<()> {
    conn.execute(
        "UPDATE sync_peers SET last_seq_sent = MAX(last_seq_sent, ?2), \
         last_seq_ack = MAX(last_seq_ack, ?3), last_seen = ?4 WHERE device = ?1",
        rusqlite::params![device, sent, ack, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// 一批远端对象：先按依赖顺序（`tables::apply_order`）应用，再把解析不了引用的
/// 对象重试一轮（同批里后到的引用对象因此也能救回来）。
pub fn apply_batch(conn: &Connection, store: &BlobStore, objects: &[RemoteObject]) -> Result<ApplyStats> {
    let mut ordered: Vec<&RemoteObject> = objects.iter().collect();
    ordered.sort_by_key(|o| tables::apply_order(&o.kind));

    let mut stats = ApplyStats::default();
    let mut retry: Vec<&RemoteObject> = Vec::new();
    for obj in ordered {
        match apply_one(conn, store, obj)? {
            Outcome::Applied => stats.applied += 1,
            Outcome::Skipped => stats.skipped += 1,
            Outcome::Conflict => stats.conflicts += 1,
            Outcome::Unresolved => retry.push(obj),
        }
    }
    for obj in retry {
        match apply_one(conn, store, obj)? {
            Outcome::Applied => stats.applied += 1,
            Outcome::Skipped => stats.skipped += 1,
            Outcome::Conflict => stats.conflicts += 1,
            Outcome::Unresolved => {
                stats.unresolved += 1;
                stats.pending.push(obj.uuid.clone());
            }
        }
    }
    Ok(stats)
}

enum Outcome {
    Applied,
    Skipped,
    Conflict,
    Unresolved,
}

fn apply_one(conn: &Connection, store: &BlobStore, obj: &RemoteObject) -> Result<Outcome> {
    let spec = match tables::spec(&obj.kind) {
        Some(s) => s,
        None => return Ok(Outcome::Skipped),
    };

    let local: Option<(i64, String, i64, String)> = conn
        .query_row(
            "SELECT hlc, device, deleted, blob FROM sync_objects WHERE uuid = ?1",
            [&obj.uuid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;

    if let Some((lhlc, ldev, ldel, lblob)) = &local {
        let local_newer = (*lhlc, ldev.as_str()) >= (obj.hlc, obj.device.as_str());
        if local_newer {
            let same = *ldel == i64::from(obj.deleted) && lblob == &obj.blob;
            if same {
                return Ok(Outcome::Skipped);
            }
            // 两边都改过、内容不同：本地这版留下，对端那版留档
            conn.execute(
                "INSERT INTO sync_conflicts (uuid, kind, kept_hlc, lost_hlc, lost_blob, at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    obj.uuid,
                    obj.kind,
                    lhlc,
                    obj.hlc,
                    obj.blob,
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
            return Ok(Outcome::Conflict);
        }
    }

    // 到这儿就是远端赢了（或本地还没有这条）
    let row_id = local_row_id(conn, spec, obj)?;
    if obj.deleted {
        if let Some(id) = &row_id {
            conn.execute(&format!("DELETE FROM {} WHERE rowid = ?1", spec.name), [id])?;
        }
    } else {
        let payload: Value = serde_json::from_str(&obj.blob)?;
        let row = payload
            .get("row")
            .cloned()
            .ok_or_else(|| crate::error::ReinError::Message("对象缺少 row".into()))?;
        let columns = match row {
            Value::Object(m) => m,
            _ => return Err(crate::error::ReinError::Message("row 不是对象".into())),
        };
        match write_row(conn, store, spec, &obj.uuid, &row_id, &columns)? {
            Some(()) => {}
            None => return Ok(Outcome::Unresolved),
        }
    }

    conn.execute(
        "INSERT INTO sync_objects (uuid, kind, hlc, device, deleted, blob) VALUES (?1,?2,?3,?4,?5,?6) \
         ON CONFLICT(uuid) DO UPDATE SET kind = excluded.kind, hlc = excluded.hlc, \
           device = excluded.device, deleted = excluded.deleted, blob = excluded.blob",
        rusqlite::params![obj.uuid, spec.name, obj.hlc, obj.device, i64::from(obj.deleted), obj.blob],
    )?;
    conn.execute(
        "INSERT INTO sync_log (uuid, hlc) VALUES (?1, ?2)",
        rusqlite::params![obj.uuid, obj.hlc],
    )?;
    Ok(Outcome::Applied)
}

/// 这条对象对应本机哪一行：映射表 → 文本主键 → 业务唯一键（都没有则 None = 插入新行）。
fn local_row_id(
    conn: &Connection,
    spec: &'static tables::TableSpec,
    obj: &RemoteObject,
) -> Result<Option<i64>> {
    if let Some(local_id) = conn
        .query_row(
            "SELECT local_id FROM sync_map WHERE kind = ?1 AND uuid = ?2",
            rusqlite::params![spec.name, obj.uuid],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        if let Ok(id) = local_id.parse::<i64>() {
            return Ok(Some(id));
        }
    }
    // 文本主键：uuid 就是 id
    if let Pk::Text(col) = spec.pk {
        let found: Option<i64> = conn
            .query_row(
                &format!("SELECT rowid FROM {} WHERE {col} = ?1", spec.name),
                [&obj.uuid],
                |r| r.get(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    // 业务唯一键：两端各自新建了同一条逻辑记录时并成一条
    if let Some(key) = spec.natural {
        if let Ok(payload) = serde_json::from_str::<Value>(&obj.blob) {
            if let Some(Value::String(value)) = payload.get("row").and_then(|r| r.get(key)) {
                let found: Option<i64> = conn
                    .query_row(
                        &format!("SELECT rowid FROM {} WHERE {key} = ?1", spec.name),
                        [value],
                        |r| r.get(0),
                    )
                    .optional()?;
                if found.is_some() {
                    return Ok(found);
                }
            }
        }
    }
    Ok(None)
}

/// 写一行：解析引用与大字段，然后按已知本地 id 更新、或插入新行。
/// `Ok(None)` = 引用暂时解析不了（整条留到下一轮），不是错误。
fn write_row(
    conn: &Connection,
    store: &BlobStore,
    spec: &'static tables::TableSpec,
    uuid: &str,
    row_id: &Option<i64>,
    columns: &Map<String, Value>,
) -> Result<Option<()>> {
    let mut names: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    for (name, raw) in columns {
        if spec.skip.contains(&name.as_str()) {
            continue;
        }
        match resolve_value(conn, store, spec, uuid, raw)? {
            Some(v) => {
                names.push(name.clone());
                values.push(v);
            }
            None => return Ok(None),
        }
    }
    if names.is_empty() {
        return Ok(Some(()));
    }

    if let Some(id) = row_id {
        let sets: Vec<String> = names.iter().map(|n| format!("{n} = ?")).collect();
        let sql = format!("UPDATE {} SET {} WHERE rowid = ?", spec.name, sets.join(", "));
        let mut params = values.clone();
        params.push(rusqlite::types::Value::Integer(*id));
        conn.execute(&sql, rusqlite::params_from_iter(params))?;
        conn.execute(
            "INSERT OR REPLACE INTO sync_map (kind, local_id, uuid) VALUES (?1, ?2, ?3)",
            rusqlite::params![spec.name, id.to_string(), uuid],
        )?;
        return Ok(Some(()));
    }

    let placeholders: Vec<&str> = names.iter().map(|_| "?").collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        spec.name,
        names.join(", "),
        placeholders.join(", ")
    );
    conn.execute(&sql, rusqlite::params_from_iter(values))?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT OR REPLACE INTO sync_map (kind, local_id, uuid) VALUES (?1, ?2, ?3)",
        rusqlite::params![spec.name, id.to_string(), uuid],
    )?;
    Ok(Some(()))
}

/// 对象里的一个值 → 本地列的 SQL 值。`Ok(None)` = 引用解析不了。
fn resolve_value(
    conn: &Connection,
    store: &BlobStore,
    spec: &'static tables::TableSpec,
    uuid: &str,
    raw: &Value,
) -> Result<Option<rusqlite::types::Value>> {
    use rusqlite::types::Value as SqlValue;

    if let Value::Object(map) = raw {
        // 引用：换成目标的本地 id
        if let Some(Value::String(target_uuid)) = map.get("__ref") {
            let found: Option<String> = conn
                .query_row(
                    "SELECT local_id FROM sync_map WHERE kind = ?1 AND uuid = ?2",
                    rusqlite::params![ref_target(spec, map), target_uuid],
                    |r| r.get(0),
                )
                .optional()?;
            return Ok(match found.and_then(|s| s.parse::<i64>().ok()) {
                Some(id) => Some(SqlValue::Integer(id)),
                None => None,
            });
        }
        // 天然键：内置食物这类两端都有、只是 id 不同的行
        if let Some(nat) = map.get("__natural") {
            let table = nat.get("table").and_then(|v| v.as_str()).unwrap_or("");
            let key = nat.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = nat.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if tables::spec(table).is_none() || key.is_empty() {
                return Ok(None);
            }
            let found: Option<i64> = conn
                .query_row(
                    &format!("SELECT rowid FROM {table} WHERE {key} = ?1"),
                    [value],
                    |r| r.get(0),
                )
                .optional()?;
            return Ok(found.map(SqlValue::Integer));
        }
        // 大字段：还原成列上原本的形态（base64 / data URL / 路径）
        if media::is_marker(raw) {
            let restored = media::decode(store, conn, uuid, raw)?;
            return Ok(Some(SqlValue::Text(restored)));
        }
    }
    Ok(Some(match raw {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        // 数组/对象：本仓的约定是存 JSON 文本
        other => SqlValue::Text(other.to_string()),
    }))
}

/// 引用指向哪张表：抓取时写在 marker 里的 `__table`（引用是自描述的）。
fn ref_target(_spec: &'static tables::TableSpec, map: &Map<String, Value>) -> String {
    map.get("__table")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 把本机身份与分组写进 `sync_meta`（配对成功后调用）。
pub fn set_group(conn: &Connection, group_id: &str, peer_device: &str, peer_name: &str, peer_pub: &str) -> Result<()> {
    meta_set(conn, "group_id", group_id)?;
    conn.execute(
        "INSERT INTO sync_peers (device, name, x25519_pub, group_id) VALUES (?1,?2,?3,?4) \
         ON CONFLICT(device) DO UPDATE SET name = excluded.name, x25519_pub = excluded.x25519_pub, \
           group_id = excluded.group_id",
        rusqlite::params![peer_device, peer_name, peer_pub, group_id],
    )?;
    Ok(())
}

/// 上次同步的足迹（状态卡片上那几行）。
pub fn record_run(conn: &Connection, path: &str, up: i64, down: i64) -> Result<()> {
    meta_set(conn, "last_at", &chrono::Utc::now().timestamp_millis().to_string())?;
    meta_set(conn, "last_path", path)?;
    let prev_up: i64 = meta_get(conn, "last_up").and_then(|v| v.parse().ok()).unwrap_or(0);
    let prev_down: i64 = meta_get(conn, "last_down").and_then(|v| v.parse().ok()).unwrap_or(0);
    meta_set(conn, "last_up", &(prev_up + up).to_string())?;
    meta_set(conn, "last_down", &(prev_down + down).to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests;
