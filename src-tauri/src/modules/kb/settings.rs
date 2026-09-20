//! 知识库设置读写（单行表 kb_settings）。

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;

use super::models::{
    KbSettings, KbSettingsInput, MODE_CLOUD, MODE_KEYWORD, MODE_LOCAL, SOURCE_TYPES,
};

const COLS: &str = "embedding_mode, cloud_base_url, cloud_api_key, cloud_model, cloud_dim, sources_enabled, \
                     auto_memory, auto_consolidate, last_consolidate_at, last_error, updated_at";

fn tail(secret: Option<&str>) -> Option<String> {
    let s = secret.filter(|s| !s.is_empty())?;
    let last4: String = s
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if s.chars().count() <= 4 {
        Some("****".to_string())
    } else {
        Some(format!("…{last4}"))
    }
}

/// 读取设置。apiKey 只回尾四位——与 AI 模型工具的做法一致，密钥不落前端明文。
pub fn get(conn: &Connection) -> Result<KbSettings> {
    let (mode, base_url, api_key, model, dim, sources, auto_memory, auto_consolidate, last_consolidate_at, last_error, updated_at) = conn
        .query_row(
            &format!("SELECT {COLS} FROM kb_settings WHERE id = 1"),
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, String>(10)?,
                ))
            },
        )?;

    Ok(KbSettings {
        embedding_mode: mode,
        cloud_base_url: base_url,
        cloud_api_key_tail: tail(api_key.as_deref()),
        cloud_model: model,
        cloud_dim: dim,
        sources_enabled: serde_json::from_str(&sources).unwrap_or(serde_json::json!({})),
        auto_memory: auto_memory != 0,
        auto_consolidate: auto_consolidate != 0,
        last_consolidate_at,
        last_error,
        updated_at,
    })
}

/// 局部更新：只写传入的字段。空字符串视为「清空该字段」。
pub fn update(conn: &Connection, input: &KbSettingsInput) -> Result<KbSettings> {
    if let Some(mode) = &input.embedding_mode {
        if ![MODE_KEYWORD, MODE_LOCAL, MODE_CLOUD].contains(&mode.as_str()) {
            return Err(crate::error::ReinError::Message(format!(
                "未知的检索模式：{mode}（可选 keyword / local / cloud）"
            )));
        }
        conn.execute(
            "UPDATE kb_settings SET embedding_mode = ?1 WHERE id = 1",
            [mode],
        )?;
    }
    if let Some(v) = &input.cloud_base_url {
        conn.execute(
            "UPDATE kb_settings SET cloud_base_url = ?1 WHERE id = 1",
            [v.trim().to_string()],
        )?;
    }
    if let Some(v) = &input.cloud_api_key {
        // 传空串 = 清除；不传 = 保留原值（前端拿不到明文，无法回传）
        let v = v.trim().to_string();
        if v.is_empty() {
            conn.execute(
                "UPDATE kb_settings SET cloud_api_key = NULL WHERE id = 1",
                [],
            )?;
        } else if v != "****" {
            conn.execute(
                "UPDATE kb_settings SET cloud_api_key = ?1 WHERE id = 1",
                [v],
            )?;
        }
    }
    if let Some(v) = &input.cloud_model {
        conn.execute(
            "UPDATE kb_settings SET cloud_model = ?1 WHERE id = 1",
            [v.trim().to_string()],
        )?;
    }
    if let Some(v) = input.cloud_dim {
        conn.execute("UPDATE kb_settings SET cloud_dim = ?1 WHERE id = 1", [v])?;
    }
    if let Some(v) = &input.sources_enabled {
        conn.execute(
            "UPDATE kb_settings SET sources_enabled = ?1 WHERE id = 1",
            [serde_json::to_string(v)?],
        )?;
    }
    if let Some(v) = input.auto_memory {
        conn.execute(
            "UPDATE kb_settings SET auto_memory = ?1 WHERE id = 1",
            [if v { 1 } else { 0 }],
        )?;
    }
    if let Some(v) = input.auto_consolidate {
        conn.execute(
            "UPDATE kb_settings SET auto_consolidate = ?1 WHERE id = 1",
            [if v { 1 } else { 0 }],
        )?;
    }
    conn.execute(
        "UPDATE kb_settings SET updated_at = datetime('now') WHERE id = 1",
        [],
    )?;
    get(conn)
}

pub fn set_last_error(conn: &Connection, msg: Option<&str>) -> Result<()> {
    conn.execute("UPDATE kb_settings SET last_error = ?1 WHERE id = 1", [msg])?;
    Ok(())
}

/// 取当前启用的来源类别。缺省（JSON 里没有该键）视为启用。
pub fn enabled_sources(conn: &Connection) -> Result<Vec<String>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT sources_enabled FROM kb_settings WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let map: serde_json::Value = raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::json!({}));

    Ok(SOURCE_TYPES
        .iter()
        .filter(|t| map.get(**t).and_then(|v| v.as_bool()).unwrap_or(true))
        .map(|t| t.to_string())
        .collect())
}

/// 云端嵌入配置的完整内容（含明文密钥），只给 Rust 侧的 embedder 用，绝不 Serialize 出进程。
pub type CloudConfig = (String, String, String, Option<i64>);

/// 云端嵌入的完整配置（含明文密钥），只给 Rust 侧的 embedder 用。
pub fn cloud_config(conn: &Connection) -> Result<Option<CloudConfig>> {
    let row = conn
        .query_row(
            "SELECT cloud_base_url, cloud_api_key, cloud_model, cloud_dim FROM kb_settings WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((Some(url), Some(key), Some(model), dim)) = row else {
        return Ok(None);
    };
    if url.trim().is_empty() || key.trim().is_empty() || model.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some((url, key, model, dim)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn defaults_are_keyword_mode_all_sources_on() {
        let conn = db();
        let s = get(&conn).unwrap();
        assert_eq!(s.embedding_mode, MODE_KEYWORD);
        assert!(s.auto_memory);
        assert_eq!(enabled_sources(&conn).unwrap().len(), SOURCE_TYPES.len());
    }

    #[test]
    fn api_key_never_round_trips_in_plaintext() {
        let conn = db();
        update(
            &conn,
            &KbSettingsInput {
                cloud_api_key: Some("sk-abcdefgh1234".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let s = get(&conn).unwrap();
        assert_eq!(s.cloud_api_key_tail.as_deref(), Some("…1234"));
        assert!(!format!("{s:?}").contains("abcdefgh"));
    }

    #[test]
    fn partial_update_keeps_other_fields() {
        let conn = db();
        update(
            &conn,
            &KbSettingsInput {
                embedding_mode: Some(MODE_CLOUD.into()),
                cloud_base_url: Some("https://api.example.com/v1".into()),
                cloud_model: Some("bge-m3".into()),
                ..Default::default()
            },
        )
        .unwrap();
        update(
            &conn,
            &KbSettingsInput {
                auto_memory: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        let s = get(&conn).unwrap();
        assert_eq!(s.embedding_mode, MODE_CLOUD);
        assert_eq!(
            s.cloud_base_url.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert_eq!(s.cloud_model.as_deref(), Some("bge-m3"));
        assert!(!s.auto_memory);
    }

    #[test]
    fn unknown_mode_is_rejected() {
        let conn = db();
        let e = update(
            &conn,
            &KbSettingsInput {
                embedding_mode: Some("magic".into()),
                ..Default::default()
            },
        );
        assert!(e.is_err());
    }

    #[test]
    fn disabling_a_source_removes_it_from_enabled() {
        let conn = db();
        update(
            &conn,
            &KbSettingsInput {
                sources_enabled: Some(serde_json::json!({ "chat_message": false })),
                ..Default::default()
            },
        )
        .unwrap();
        let enabled = enabled_sources(&conn).unwrap();
        assert!(!enabled.contains(&"chat_message".to_string()));
        assert!(enabled.contains(&"todo".to_string()));
    }

    #[test]
    fn cloud_config_requires_all_three_fields() {
        let conn = db();
        assert!(cloud_config(&conn).unwrap().is_none());
        update(
            &conn,
            &KbSettingsInput {
                cloud_base_url: Some("https://x/v1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            cloud_config(&conn).unwrap().is_none(),
            "缺 key/model 时不该算配置完整"
        );
        update(
            &conn,
            &KbSettingsInput {
                cloud_api_key: Some("k".into()),
                cloud_model: Some("m".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cloud_config(&conn).unwrap().is_some());
    }
}
