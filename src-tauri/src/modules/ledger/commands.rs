//! 记账域命令 · 命令名与前端 `ledgerService.ts` 对应。

use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;
use chrono::Utc;

use super::models::{LedgerEntry, LedgerEntryInput, LedgerSettings};

const COLS: &str = "id, kind, category, amount_cents, note, date, created_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LedgerEntry> {
    Ok(LedgerEntry {
        id: row.get(0)?,
        kind: row.get(1)?,
        category: row.get(2)?,
        amount_cents: row.get(3)?,
        note: row.get(4)?,
        date: row.get(5)?,
        created_at: row.get(6)?,
    })
}

/// 区间流水；category 过滤分类 key；keyword 模糊匹配备注（后端拼接通配符）。
#[tauri::command]
pub fn list_ledger_entries(
    state: State<AppState>,
    start_date: String,
    end_date: String,
    category: Option<String>,
    keyword: Option<String>,
) -> Result<Vec<LedgerEntry>> {
    let conn = state.db.lock().unwrap();
    let mut sql = format!(
        "SELECT {COLS} FROM ledger_entries WHERE date BETWEEN ?1 AND ?2 ORDER BY date DESC, id DESC"
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&start_date, &end_date];
    let like: Option<String> = keyword.map(|k| format!("%{}%", k.trim()));
    if let Some(cat) = &category {
        sql.push_str(" AND category = ?");
        params.push(cat);
    }
    if let Some(l) = &like {
        sql.push_str(" AND note LIKE ?");
        params.push(l);
    }
    let mut stmt = conn.prepare(&sql)?;
    let entries = stmt
        .query_map(params.as_slice(), from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(entries)
}

#[tauri::command]
pub fn create_ledger_entry(state: State<AppState>, input: LedgerEntryInput) -> Result<LedgerEntry> {
    if input.amount_cents <= 0 {
        return Err(ReinError::Message("金额必须大于 0".into()));
    }
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO ledger_entries (kind, category, amount_cents, note, date, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            input.kind,
            input.category,
            input.amount_cents,
            input.note,
            input.date,
            now
        ],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {COLS} FROM ledger_entries WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row)?)
}

/// 全量更新（前端持有完整对象；避免设计 patch 合并逻辑）。
#[tauri::command]
pub fn update_ledger_entry(state: State<AppState>, entry: LedgerEntry) -> Result<LedgerEntry> {
    if entry.amount_cents <= 0 {
        return Err(ReinError::Message("金额必须大于 0".into()));
    }
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE ledger_entries SET kind = ?1, category = ?2, amount_cents = ?3, note = ?4, date = ?5 \
         WHERE id = ?6",
        rusqlite::params![
            entry.kind,
            entry.category,
            entry.amount_cents,
            entry.note,
            entry.date,
            entry.id
        ],
    )?;
    let sql = format!("SELECT {COLS} FROM ledger_entries WHERE id = ?1");
    Ok(conn.query_row(&sql, [entry.id], from_row)?)
}

#[tauri::command]
pub fn delete_ledger_entry(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM ledger_entries WHERE id = ?1", [id])?;
    Ok(())
}

fn settings_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LedgerSettings> {
    Ok(LedgerSettings {
        id: row.get(0)?,
        monthly_budget_cents: row.get(1)?,
        updated_at: row.get(2)?,
    })
}

#[tauri::command]
pub fn get_ledger_budget(state: State<AppState>) -> Result<LedgerSettings> {
    let conn = state.db.lock().unwrap();
    Ok(conn.query_row(
        "SELECT id, monthly_budget_cents, updated_at FROM ledger_settings WHERE id = 1",
        [],
        settings_from_row,
    )?)
}

#[tauri::command]
pub fn set_ledger_budget(state: State<AppState>, monthly_budget_cents: i64) -> Result<LedgerSettings> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO ledger_settings (id, monthly_budget_cents, updated_at) VALUES (1, ?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET monthly_budget_cents = ?1, updated_at = ?2",
        rusqlite::params![monthly_budget_cents, now],
    )?;
    Ok(conn.query_row(
        "SELECT id, monthly_budget_cents, updated_at FROM ledger_settings WHERE id = 1",
        [],
        settings_from_row,
    )?)
}
