//! 变更捕获：把「本地有人改了数据」这件事变成 `sync_objects` 里的一条对象。
//!
//! ---------- 为什么要绕一圈 update_hook ----------
//!
//! 全应用写库都走同一个 `Mutex<Connection>`，所以**一个 `update_hook` 就能看见所有写入**：
//! 哪个表、哪一行的 rowid、插入还是更新还是删除。比逐表写 SQL 触发器少 70 多条 SQL，
//! 也比在每个命令里手动埋点可靠（200 多个命令，漏一个就是一类数据永远同步不出去）。
//!
//! 钩子里**只能记一笔**，不能读库：SQLite 不允许在钩子回调里重入同一个连接。
//! 所以钩子只往脏队列塞 `(table, rowid, op)`，真正的读行、拼 JSON、抽大字段由
//! `rein-sync` 线程每 500ms 做一批 —— 顺带把同批的多次改动合并掉
//! （插入后连删 = 什么都没发生；更新再删 = 只发墓碑）。
//!
//! ---------- 对象长什么样 ----------
//!
//! ```json
//! { "v": 1, "row": { "title": "买菜", "program_id": { "__ref": "<uuid>" } } }
//! ```
//!
//! 三条约定：
//! 1. **本地 id 不进对象**（`Pk::Local` / `Singleton` 的 `id` 列）—— 它是本机的别名，
//!    对端会分配自己的 id，两边靠 `sync_map` 对齐；
//! 2. **整数外键换成引用**：目标的 uuid（`__ref`），目标行从没同步过时退化成天然键
//!    （`__natural`，如内置食物按名字找）；指向不同步的表则一律丢弃（`null`）；
//! 3. **大字段换成 blob 引用**（见 `media`）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::error::Result;

use super::blobs::BlobStore;
use super::identity;
use super::media;
use super::tables::{self, Pk, TableSpec};
use super::{meta_get, meta_set, set_pending};

/// 一条脏记录：哪个表、哪一行、什么操作（i/u/d）。
#[derive(Debug, Clone)]
pub struct Raw {
    pub table: String,
    pub rowid: i64,
    pub op: char,
}

/// 超过这个长度的文本列一律走 blob 通道（见 `build_row` 的通用闸门）。
pub const OVERSIZE_COLUMN_BYTES: usize = 64 * 1024;

/// 脏队列：钩子往里塞，同步线程成批取。
pub struct Dirty {
    q: Mutex<Vec<Raw>>,
    cv: Condvar,
}

impl Dirty {
    pub fn new() -> Self {
        Self {
            q: Mutex::new(Vec::new()),
            cv: Condvar::new(),
        }
    }

    fn push(&self, raw: Raw) {
        if let Ok(mut q) = self.q.lock() {
            q.push(raw);
            self.cv.notify_one();
        }
    }

    /// 取一批（最多等 `wait_ms` 毫秒）。返回前先把同 `(table, rowid)` 的多次改动合并：
    /// 只看最后一次操作，但**插入后删除**要整条抹掉（那行从来没告诉过别人）。
    pub fn drain(&self, wait_ms: u64) -> Vec<Raw> {
        let mut q = match self.q.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if q.is_empty() {
            let (next, _) = match self
                .cv
                .wait_timeout(q, Duration::from_millis(wait_ms))
            {
                Ok(v) => v,
                Err(p) => p.into_inner(),
            };
            q = next;
        }
        let taken: Vec<Raw> = q.drain(..).collect();
        drop(q);
        merge(taken)
    }
}

impl Default for Dirty {
    fn default() -> Self {
        Self::new()
    }
}

/// 同批改动合并（保持首次出现的顺序，后面的覆盖前面的）。
fn merge(items: Vec<Raw>) -> Vec<Raw> {
    let mut out: Vec<Raw> = Vec::new();
    for raw in items {
        match out.iter_mut().find(|r| r.table == raw.table && r.rowid == raw.rowid) {
            Some(slot) => {
                // 插入后又删除 = 这行从没存在过，整条丢掉（别的设备压根不知道它）
                if slot.op == 'i' && raw.op == 'd' {
                    let table = slot.table.clone();
                    let rowid = slot.rowid;
                    out.retain(|r| !(r.table == table && r.rowid == rowid));
                } else {
                    slot.op = raw.op;
                }
            }
            None => out.push(raw),
        }
    }
    out
}

/// 在连接上装钩子。表没登记就整个忽略（`sync_*` 自己的写入因此不会自激）。
pub fn install_hook(conn: &Connection, dirty: Arc<Dirty>) {
    conn.update_hook(Some(
        move |action: rusqlite::hooks::Action, _db: &str, table: &str, rowid: i64| {
            if rowid <= 0 || tables::spec(table).is_none() {
                return;
            }
            // Action 是 non_exhaustive：认不出来的操作整条忽略，别猜
            let op = match action {
                rusqlite::hooks::Action::SQLITE_INSERT => 'i',
                rusqlite::hooks::Action::SQLITE_UPDATE => 'u',
                rusqlite::hooks::Action::SQLITE_DELETE => 'd',
                _ => return,
            };
            dirty.push(Raw {
                table: table.to_string(),
                rowid,
                op,
            });
        },
    ));
}

/// 单调递增的逻辑时间戳（毫秒）：本机连续两次改动不会撞成同一个值。
fn next_hlc(conn: &Connection) -> Result<i64> {
    let now = chrono::Utc::now().timestamp_millis();
    let last: i64 = meta_get(conn, "last_hlc")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let v = now.max(last + 1);
    meta_set(conn, "last_hlc", &v.to_string())?;
    Ok(v)
}

fn append_log(conn: &Connection, uuid: &str, hlc: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_log (uuid, hlc) VALUES (?1, ?2)",
        rusqlite::params![uuid, hlc],
    )?;
    Ok(())
}

fn mapped_uuid(conn: &Connection, kind: &str, local_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT uuid FROM sync_map WHERE kind = ?1 AND local_id = ?2",
            rusqlite::params![kind, local_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

fn remember_map(conn: &Connection, kind: &str, local_id: &str, uuid: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_map (kind, local_id, uuid) VALUES (?1, ?2, ?3)",
        rusqlite::params![kind, local_id, uuid],
    )?;
    Ok(())
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    tables::column_names(conn, table)
}

fn value_to_json(v: rusqlite::types::ValueRef<'_>) -> Value {
    match v {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(i) => Value::from(i),
        rusqlite::types::ValueRef::Real(f) => Value::from(f),
        rusqlite::types::ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
        rusqlite::types::ValueRef::Blob(b) => {
            use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
            Value::String(B64.encode(b))
        }
    }
}

/// 整数外键 → 引用。三种结果：目标的 uuid、天然键兜底、或丢弃（null）。
fn remap_ref(conn: &Connection, r: &tables::Ref, value: &Value) -> Result<Value> {
    let local = match value {
        Value::Null => return Ok(Value::Null),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return Ok(Value::Null),
    };
    let target = match r.target {
        // 指向不同步的表：对端没有那行，留着就是悬空 id
        None => return Ok(Value::Null),
        Some(t) => t,
    };
    if let Some(uuid) = mapped_uuid(conn, target, &local)? {
        // 带上目标表名：引用是自描述的，应用端才知道该去查哪张表的映射
        return Ok(serde_json::json!({ "__ref": uuid, "__table": target }));
    }
    // 目标行没同步过（典型：内置食物）——退化成天然键，由对端按名字找
    if let Some(key) = tables::spec(target).and_then(|s| s.natural) {
        let sql = format!("SELECT {key} FROM {target} WHERE rowid = ?1");
        let natural: Option<String> = conn
            .query_row(&sql, [&local], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten();
        if let Some(natural) = natural {
            return Ok(serde_json::json!({
                "__natural": { "table": target, "key": key, "value": natural },
            }));
        }
    }
    Ok(Value::Null)
}

/// 读一行 → 对象里的 `row`。
fn build_row(conn: &Connection, store: &BlobStore, spec: &'static TableSpec, rowid: i64) -> Result<Option<Value>> {
    let cols = column_names(conn, spec.name)?;
    let mut stmt = conn.prepare(&format!("SELECT * FROM {} WHERE rowid = ?1", spec.name))?;
    let mut rows = stmt.query([rowid])?;
    let row = match rows.next()? {
        Some(r) => r,
        None => return Ok(None),
    };
    let drop_pk = matches!(spec.pk, Pk::Local | Pk::Singleton);
    let mut map = Map::new();
    for (i, name) in cols.iter().enumerate() {
        if spec.skip.contains(&name.as_str()) {
            continue;
        }
        if drop_pk && name == "id" {
            continue;
        }
        let value = value_to_json(row.get_ref(i)?);
        if let Some(r) = spec.refs.iter().find(|r| r.column == name.as_str()) {
            map.insert(name.clone(), remap_ref(conn, r, &value)?);
            continue;
        }
        if let Some((_, kind)) = spec.media.iter().find(|(c, _)| c == name) {
            if let Value::String(s) = &value {
                if let Some(m) = media::encode(store, *kind, conn, s)? {
                    map.insert(name.clone(), m);
                    continue;
                }
            }
        }
        // 通用闸门：**任何**列只要大到这个尺寸就走 blob 通道。
        // 登记表里的 media 声明是我们的预期，而这里是兜底 —— 大文本（知识库正文、
        // 长备注、以后新增的列）不该因为「没登记」就把单条对象撑成几 MB：
        // 帧层要能分块、中继只肯走小对象，都建立在这条上。
        if let Value::String(s) = &value {
            if s.len() >= OVERSIZE_COLUMN_BYTES {
                let hash = store.put(conn, s.as_bytes())?;
                map.insert(
                    name.clone(),
                    serde_json::json!({ "__blob": hash, "bytes": s.len(), "enc": "text" }),
                );
                continue;
            }
        }
        map.insert(name.clone(), value);
    }
    Ok(Some(Value::Object(map)))
}

/// 一条脏记录 → `sync_objects` + `sync_log`。返回受影响的 uuid（无需处理时为 None）。
pub fn capture(
    conn: &Connection,
    store: &BlobStore,
    me: &str,
    raw: &Raw,
) -> Result<Option<String>> {
    let spec = match tables::spec(&raw.table) {
        Some(s) => s,
        None => return Ok(None),
    };
    // 只同步符合条件的行（内置食物、内置动作、系统文件）
    if let Some(cond) = spec.filter {
        let sql = format!("SELECT COUNT(*) FROM {} WHERE rowid = ?1 AND {cond}", spec.name);
        let hit: i64 = conn.query_row(&sql, [raw.rowid], |r| r.get(0))?;
        if hit == 0 {
            return Ok(None);
        }
    }

    let local_id = raw.rowid.to_string();
    let uuid = match spec.pk {
        // 文本主键：行还在就读它，行没了（删除）才靠映射表
        Pk::Text(col) => {
            let current: Option<String> = conn
                .query_row(
                    &format!("SELECT {col} FROM {} WHERE rowid = ?1", spec.name),
                    [raw.rowid],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            match current {
                Some(s) => s,
                None => match mapped_uuid(conn, spec.name, &local_id)? {
                    Some(u) => u,
                    None => return Ok(None),
                },
            }
        }
        Pk::Singleton => format!("singleton:{}", spec.name),
        Pk::Local => match mapped_uuid(conn, spec.name, &local_id)? {
            Some(u) => u,
            None => {
                if raw.op == 'd' {
                    // 从没告诉过别人，删了也不用通知谁
                    return Ok(None);
                }
                let u = uuid::Uuid::new_v4().to_string();
                remember_map(conn, spec.name, &local_id, &u)?;
                u
            }
        },
    };
    // 文本主键也登记一份：删除时只剩它可查
    remember_map(conn, spec.name, &local_id, &uuid)?;

    let hlc = next_hlc(conn)?;
    if raw.op == 'd' {
        let updated = conn.execute(
            "UPDATE sync_objects SET deleted = 1, hlc = ?2, device = ?3, blob = '{}' WHERE uuid = ?1",
            rusqlite::params![uuid, hlc, me],
        )?;
        if updated == 0 {
            return Ok(None);
        }
        append_log(conn, &uuid, hlc)?;
        return Ok(Some(uuid));
    }

    let row = match build_row(conn, store, spec, raw.rowid)? {
        Some(v) => v,
        None => return Ok(None),
    };
    let payload = serde_json::json!({ "v": 1, "row": row }).to_string();
    // 内容没变就别新增版本：应用远端对象会写库、写库又触发钩子，少了这条两台设备
    // 会把对方的对象原样发回去，永远不收敛（`apply` 的模块头有完整说明）。
    let existing: Option<(String, i64)> = conn
        .query_row(
            "SELECT blob, deleted FROM sync_objects WHERE uuid = ?1",
            [&uuid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((blob, deleted)) = existing {
        if deleted == 0 && blob == payload {
            return Ok(Some(uuid));
        }
    }
    conn.execute(
        "INSERT INTO sync_objects (uuid, kind, hlc, device, deleted, blob) \
         VALUES (?1, ?2, ?3, ?4, 0, ?5) \
         ON CONFLICT(uuid) DO UPDATE SET kind = excluded.kind, hlc = excluded.hlc, \
           device = excluded.device, deleted = 0, blob = excluded.blob",
        rusqlite::params![uuid, spec.name, hlc, me, payload],
    )?;
    append_log(conn, &uuid, hlc)?;
    Ok(Some(uuid))
}

/// 存量补录（第一次运行，或某张表的结构变了）。
///
/// 变更钩子只看得到**今后**的写入：升级上来的安装里已经躺着几千行（待办、做组记录、
/// 饮食记录……），它们从没被捕获过 —— 第一次同步会是空的，而「两台设备各有一半历史」
/// 正是这个功能要解决的事。所以开机先补一遍：逐表走 rowid，把每一行都过一遍 `capture`
/// （幂等：内容与已存对象相同就什么都不做）。
///
/// 结构变了也要重来一遍：`ALTER TABLE ADD COLUMN` 是 DDL，不触发变更钩子，
/// 那些行的对象里因此缺这一列，对端只能拿到列默认值。所以每张表记一个**列指纹**，
/// 开机比对；指纹变了就重扫这张表 —— 迁移加了列，下一次开机自动补上。
pub fn backfill(conn: &Connection, store: &BlobStore, me: &str) -> Result<BackfillStats> {
    let mut stats = BackfillStats::default();
    for spec in tables::TABLES {
        let fingerprint = column_fingerprint(conn, spec.name)?;
        let key = format!("fp:{}", spec.name);
        if meta_get(conn, &key).as_deref() == Some(fingerprint.as_str()) {
            continue;
        }
        let rowids: Vec<i64> = {
            let mut stmt = conn.prepare(&format!("SELECT rowid FROM {} ORDER BY rowid", spec.name))?;
            let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            out
        };
        stats.tables += 1;
        stats.scanned += rowids.len() as i64;
        for rowid in rowids {
            let raw = Raw {
                table: spec.name.to_string(),
                rowid,
                op: 'u',
            };
            if capture(conn, store, me, &raw)?.is_some() {
                stats.captured += 1;
            }
        }
        meta_set(conn, &key, &fingerprint)?;
    }
    Ok(stats)
}

#[derive(Default, Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillStats {
    pub tables: i64,
    pub scanned: i64,
    /// 真正产生了对象（或新版本）的行数；其余是因为「内容没变」跳过
    pub captured: i64,
}

/// 列指纹：列名 + 类型 + 非空标记。迁移加/删/改列都会变。
fn column_fingerprint(conn: &Connection, table: &str) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| {
        Ok(format!(
            "{}:{}:{}",
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?
        ))
    })?;
    let mut hasher = Sha256::new();
    for r in rows {
        hasher.update(r?.as_bytes());
        hasher.update(b"|");
    }
    Ok(hasher
        .finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// 还差几张表没补录（状态卡片如实显示）。
pub fn stale_tables(conn: &Connection) -> Result<i64> {
    let mut n = 0;
    for spec in tables::TABLES {
        let key = format!("fp:{}", spec.name);
        if meta_get(conn, &key).as_deref() != Some(column_fingerprint(conn, spec.name)?.as_str()) {
            n += 1;
        }
    }
    Ok(n)
}

/// 同步线程：等脏队列 → 捕获 → 更新积压计数。
pub struct SyncHub {
    data_dir: PathBuf,
    dirty: Arc<Dirty>,
    running: AtomicBool,
}

impl SyncHub {
    pub fn new(data_dir: PathBuf, dirty: Arc<Dirty>) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            dirty,
            running: AtomicBool::new(true),
        })
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let hub = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("rein-sync".into())
            .spawn(move || hub.loop_forever(app));
        if let Err(e) = spawned {
            // 起不来就如实说：同步会停在「本地有改动但没人捕获」，而不是静默不动
            eprintln!("rein-sync 线程启动失败：{e}");
        }
    }

    fn loop_forever(&self, app: AppHandle) {
        let store = BlobStore::new(&self.data_dir);
        // 开机先补存量与结构变化（幂等：表结构没变时只比一次指纹，几乎不花时间）
        if let Err(e) = self.run_backfill(&app, &store) {
            eprintln!("同步存量补录失败：{e}");
        }
        while self.running.load(Ordering::Relaxed) {
            let batch = self.dirty.drain(500);
            if batch.is_empty() {
                continue;
            }
            set_pending(batch.len() as i64);
            if let Err(e) = self.capture_batch(&app, &store, &batch) {
                eprintln!("同步捕获失败：{e}");
            }
            set_pending(0);
        }
    }

    fn capture_batch(&self, app: &AppHandle, store: &BlobStore, batch: &[Raw]) -> Result<()> {
        let state = app.state::<crate::state::AppState>();
        let conn = state.db.lock();
        let me = identity::ensure(&conn)?.device_id;
        for raw in batch {
            capture(&conn, store, &me, raw)?;
        }
        Ok(())
    }

    /// 立刻把脏队列落成对象。同步会话开始前调用 —— 否则刚改的东西会落在这一次之后，
    /// 用户看到的就是「点了同步，刚才那条没过去」。
    pub fn flush(&self, conn: &Connection, store: &BlobStore, me: &str) -> Result<usize> {
        let batch = self.dirty.drain(0);
        for raw in &batch {
            capture(conn, store, me, raw)?;
        }
        if !batch.is_empty() {
            set_pending(0);
        }
        Ok(batch.len())
    }

    /// 数据目录（命令层要用它拼 blob 库路径）。
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    fn run_backfill(&self, app: &AppHandle, store: &BlobStore) -> Result<BackfillStats> {
        let state = app.state::<crate::state::AppState>();
        let conn = state.db.lock();
        let me = identity::ensure(&conn)?.device_id;
        backfill(&conn, store, &me)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;

    struct Env {
        conn: Connection,
        store: BlobStore,
        dir: PathBuf,
        me: String,
    }

    fn env() -> Env {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!("rein-sync-capture-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = BlobStore::new(&dir);
        let me = identity::ensure(&conn).unwrap().device_id;
        Env {
            conn,
            store,
            dir,
            me,
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn objects(conn: &Connection) -> Vec<(String, String, i64, String)> {
        let mut stmt = conn
            .prepare("SELECT uuid, kind, deleted, blob FROM sync_objects ORDER BY hlc")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    #[test]
    fn insert_creates_object_and_log() {
        let e = env();
        e.conn
            .execute(
                "INSERT INTO todos (id, title, created_at) VALUES (7, '买菜', '2026-09-28')",
                [],
            )
            .unwrap();
        let uuid = capture(
            &e.conn,
            &e.store,
            &e.me,
            &Raw {
                table: "todos".into(),
                rowid: 7,
                op: 'i',
            },
        )
        .unwrap()
        .unwrap();
        assert!(!uuid.is_empty());
        let objs = objects(&e.conn);
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0].1, "todos");
        assert_eq!(objs[0].2, 0);
        assert!(objs[0].3.contains("买菜"));
        assert!(!objs[0].3.contains("\"id\""), "本地 id 不该进对象");
        let logs: i64 = e
            .conn
            .query_row("SELECT COUNT(*) FROM sync_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logs, 1);
    }

    #[test]
    fn update_reuses_uuid_and_appends_log() {
        let e = env();
        e.conn
            .execute(
                "INSERT INTO todos (id, title, created_at) VALUES (1, 'a', 'now')",
                [],
            )
            .unwrap();
        let first = capture(&e.conn, &e.store, &e.me, &Raw { table: "todos".into(), rowid: 1, op: 'i' })
            .unwrap()
            .unwrap();
        e.conn
            .execute("UPDATE todos SET title = 'b' WHERE id = 1", [])
            .unwrap();
        let second = capture(&e.conn, &e.store, &e.me, &Raw { table: "todos".into(), rowid: 1, op: 'u' })
            .unwrap()
            .unwrap();
        assert_eq!(first, second, "同一行必须落到同一个 uuid");
        let objs = objects(&e.conn);
        assert_eq!(objs.len(), 1);
        assert!(objs[0].3.contains("\"b\""));
        let logs: i64 = e
            .conn
            .query_row("SELECT COUNT(*) FROM sync_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logs, 2);
    }

    #[test]
    fn delete_writes_tombstone_but_only_if_known() {
        let e = env();
        // 没同步过的行：删除不留墓碑（别人压根不知道它）
        e.conn
            .execute("INSERT INTO todos (id, title, created_at) VALUES (5, 'x', 'now')", [])
            .unwrap();
        assert!(capture(&e.conn, &e.store, &e.me, &Raw { table: "todos".into(), rowid: 5, op: 'd' })
            .unwrap()
            .is_none());
        assert!(objects(&e.conn).is_empty());

        // 同步过的行：删除写墓碑
        e.conn
            .execute("INSERT INTO todos (id, title, created_at) VALUES (6, 'y', 'now')", [])
            .unwrap();
        capture(&e.conn, &e.store, &e.me, &Raw { table: "todos".into(), rowid: 6, op: 'i' }).unwrap();
        e.conn.execute("DELETE FROM todos WHERE id = 6", []).unwrap();
        let uuid = capture(&e.conn, &e.store, &e.me, &Raw { table: "todos".into(), rowid: 6, op: 'd' })
            .unwrap()
            .unwrap();
        assert!(!uuid.is_empty());
        let objs = objects(&e.conn);
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0].2, 1, "墓碑");
    }

    #[test]
    fn ref_becomes_uuid_then_natural_key() {
        let e = env();
        // 内置食物（is_custom = 0）：不参与同步 → 走天然键
        e.conn
            .execute(
                "INSERT INTO foods (id, name, is_custom, created_at) VALUES (1, '鸡蛋', 0, 'now')",
                [],
            )
            .unwrap();
        // 自建食物：参与同步 → 走 uuid
        e.conn
            .execute(
                "INSERT INTO foods (id, name, is_custom, created_at) VALUES (2, '自制酸奶', 1, 'now')",
                [],
            )
            .unwrap();
        capture(&e.conn, &e.store, &e.me, &Raw { table: "foods".into(), rowid: 2, op: 'i' }).unwrap();

        e.conn
            .execute(
                "INSERT INTO meal_logs (id, food_id, date, meal_type, quantity_mode, grams, source, created_at) \
                 VALUES (1, 1, '2026-09-28', 'lunch', 'grams', 100, 'manual', 'now')",
                [],
            )
            .unwrap();
        capture(&e.conn, &e.store, &e.me, &Raw { table: "meal_logs".into(), rowid: 1, op: 'i' }).unwrap();
        let blob = objects(&e.conn)
            .into_iter()
            .find(|o| o.1 == "meal_logs")
            .unwrap()
            .3;
        assert!(blob.contains("__natural"), "内置食物应按名字兜底：{blob}");
        assert!(blob.contains("鸡蛋"));

        e.conn
            .execute(
                "INSERT INTO meal_logs (id, food_id, date, meal_type, quantity_mode, grams, source, created_at) \
                 VALUES (2, 2, '2026-09-28', 'lunch', 'grams', 50, 'manual', 'now')",
                [],
            )
            .unwrap();
        capture(&e.conn, &e.store, &e.me, &Raw { table: "meal_logs".into(), rowid: 2, op: 'i' }).unwrap();
        let blob = objects(&e.conn)
            .into_iter()
            .filter(|o| o.1 == "meal_logs")
            .nth(1)
            .unwrap()
            .3;
        assert!(blob.contains("__ref"), "自建食物应按 uuid：{blob}");
    }

    /// 指向不同步的表（校园课次）时整列丢弃，不留悬空 id。
    ///
    /// 这一条测的是**引用改写**而不是外键：`course_session_id` 的外键指向校园课次表，
    /// 造那条链要账号/学期/课程一串前置数据，所以这里关掉外键强制 ——
    /// 生产路径上那一列存的是真实课次，改写成 null 的规则完全一样。
    #[test]
    fn ref_to_unsynced_table_is_dropped() {
        let e = env();
        e.conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        e.conn
            .execute(
                "INSERT INTO todos (id, title, created_at, course_session_id) VALUES (3, 't', 'now', 42)",
                [],
            )
            .unwrap();
        capture(&e.conn, &e.store, &e.me, &Raw { table: "todos".into(), rowid: 3, op: 'i' }).unwrap();
        let blob = objects(&e.conn).remove(0).3;
        assert!(blob.contains("\"course_session_id\":null"), "{blob}");
    }

    /// 单行表：整表一条对象，id 不进对象。
    #[test]
    fn singleton_object() {
        let e = env();
        e.conn
            .execute("UPDATE profile SET nickname = '小陈' WHERE id = 1", [])
            .unwrap();
        let uuid = capture(&e.conn, &e.store, &e.me, &Raw { table: "profile".into(), rowid: 1, op: 'u' })
            .unwrap()
            .unwrap();
        assert_eq!(uuid, "singleton:profile");
        let blob = objects(&e.conn).remove(0).3;
        assert!(blob.contains("小陈"));
        assert!(!blob.contains("\"id\""));
    }

    /// 文本主键：uuid 就是那个 id。
    #[test]
    fn text_pk_uses_its_own_id() {
        let e = env();
        e.conn
            .execute(
                "INSERT INTO ai_chats (id, title, created_at, updated_at) VALUES ('c-1', '聊天', 'now', 'now')",
                [],
            )
            .unwrap();
        let uuid = capture(&e.conn, &e.store, &e.me, &Raw { table: "ai_chats".into(), rowid: 1, op: 'i' })
            .unwrap()
            .unwrap();
        assert_eq!(uuid, "c-1");
    }

    /// 只同步自建食物：内置食物改一行不该产生对象。
    #[test]
    fn filter_skips_builtin_foods() {
        let e = env();
        e.conn
            .execute(
                "INSERT INTO foods (id, name, is_custom, created_at) VALUES (9, '鸡蛋', 0, 'now')",
                [],
            )
            .unwrap();
        assert!(capture(&e.conn, &e.store, &e.me, &Raw { table: "foods".into(), rowid: 9, op: 'i' })
            .unwrap()
            .is_none());
    }

    #[test]
    fn merge_collapses_batches() {
        let out = merge(vec![
            Raw { table: "todos".into(), rowid: 1, op: 'i' },
            Raw { table: "todos".into(), rowid: 1, op: 'u' },
            Raw { table: "todos".into(), rowid: 2, op: 'i' },
            Raw { table: "todos".into(), rowid: 2, op: 'd' },
            Raw { table: "todos".into(), rowid: 3, op: 'u' },
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].rowid, 1);
        assert_eq!(out[0].op, 'u');
        assert_eq!(out[1].rowid, 3);
    }

    /// 未登记的表（含 sync_* 自己）不进队列 —— 否则捕获会自激。
    #[test]
    fn hook_ignores_unregistered_tables() {
        let dirty = Arc::new(Dirty::new());
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        install_hook(&conn, Arc::clone(&dirty));
        conn.execute(
            "INSERT INTO sync_blobs (hash, bytes, created_at) VALUES ('x', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO app_meta (key, value) VALUES ('k', 'v')", [])
            .unwrap();
        assert!(dirty.drain(10).is_empty(), "未登记的表不该进队列");
        conn.execute(
            "INSERT INTO todos (id, title, created_at) VALUES (11, 'x', 'now')",
            [],
        )
        .unwrap();
        let batch = dirty.drain(10);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].table, "todos");
        assert_eq!(batch[0].op, 'i');
    }

    /// 存量补录：升级上来的库里已经躺着的行，第一次同步必须带上。
    #[test]
    fn backfill_captures_existing_rows() {
        let e = env();
        // 直接写库（不走 capture，模拟「升级前的历史数据」）
        e.conn
            .execute(
                "INSERT INTO todos (id, title, created_at) VALUES (1, '老的待办', '2026-01-01')",
                [],
            )
            .unwrap();
        e.conn
            .execute(
                "INSERT INTO foods (id, name, is_custom, created_at) VALUES (1, '自制酸奶', 1, '2026-01-01')",
                [],
            )
            .unwrap();
        e.conn
            .execute(
                "INSERT INTO foods (id, name, is_custom, created_at) VALUES (2, '鸡蛋', 0, '2026-01-01')",
                [],
            )
            .unwrap();

        let stats = backfill(&e.conn, &e.store, &e.me).unwrap();
        assert!(stats.captured >= 2, "{stats:?}");
        let kinds: Vec<String> = objects(&e.conn).into_iter().map(|o| o.1).collect();
        assert!(kinds.contains(&"todos".to_string()));
        assert!(kinds.contains(&"foods".to_string()));
        assert_eq!(
            kinds.iter().filter(|k| *k == "foods").count(),
            1,
            "内置食物不进同步"
        );
        assert_eq!(stale_tables(&e.conn).unwrap(), 0, "补完就没有陈旧表了");

        // 第二次是幂等的：不再新增对象、也不再写日志
        let objects_before = objects(&e.conn).len();
        let logs_before: i64 = e
            .conn
            .query_row("SELECT COUNT(*) FROM sync_log", [], |r| r.get(0))
            .unwrap();
        let again = backfill(&e.conn, &e.store, &e.me).unwrap();
        assert_eq!(again.tables, 0, "指纹没变就不该重扫");
        assert_eq!(objects(&e.conn).len(), objects_before);
        assert_eq!(
            e.conn
                .query_row("SELECT COUNT(*) FROM sync_log", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            logs_before
        );
    }

    /// 表结构变了（迁移加列）要重扫：ALTER 是 DDL，不触发变更钩子。
    #[test]
    fn backfill_reruns_after_schema_change() {
        let e = env();
        e.conn
            .execute("INSERT INTO todos (id, title, created_at) VALUES (1, 'x', 'now')", [])
            .unwrap();
        backfill(&e.conn, &e.store, &e.me).unwrap();
        assert_eq!(stale_tables(&e.conn).unwrap(), 0);

        e.conn
            .execute("ALTER TABLE todos ADD COLUMN extra_note TEXT", [])
            .unwrap();
        assert!(stale_tables(&e.conn).unwrap() > 0, "加列之后该认得出来");

        e.conn
            .execute("UPDATE todos SET extra_note = '新列的值' WHERE id = 1", [])
            .unwrap();
        backfill(&e.conn, &e.store, &e.me).unwrap();
        let blob = objects(&e.conn)
            .into_iter()
            .find(|o| o.1 == "todos")
            .unwrap()
            .3;
        assert!(blob.contains("extra_note"), "重扫后新列要进对象：{blob}");
        assert!(blob.contains("新列的值"));
        assert_eq!(stale_tables(&e.conn).unwrap(), 0);
    }
}
