use serde::{Deserialize, Serialize};

use crate::memory::LoreEntry;
use crate::{Agent, new_id, now_ms};

// ============================================================
// 酒馆（SillyTavern）角色卡导入
// 支持：PNG 角色卡（tEXt/iTXt 的 chara chunk）、JSON 卡（V1 / V2）
// ============================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImportedCard {
    pub agent: Agent,
    pub lore: Vec<LoreEntry>,
}

#[derive(Deserialize)]
struct CardData {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub scenario: String,
    #[serde(default)]
    pub first_mes: String,
    #[serde(default)]
    pub mes_example: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub post_history_instructions: String,
    #[serde(default)]
    pub alternate_greetings: Vec<String>,
    #[serde(default)]
    pub character_book: Option<CharacterBook>,
}

#[derive(Deserialize)]
struct CharacterBook {
    #[serde(default)]
    pub entries: Vec<BookEntry>,
}

#[derive(Deserialize)]
struct BookEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub secondary_keys: Vec<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub constant: Option<bool>,
    #[serde(default)]
    pub insertion_order: Option<i32>,
}

pub fn import_tavern_card(path: &str) -> Result<ImportedCard, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;
    let json_str = if is_png(&bytes) {
        extract_chara_chunk(&bytes)?
    } else {
        String::from_utf8(bytes).map_err(|_| "文件既不是 PNG 也不是文本 JSON".to_string())?
    };

    let raw: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("角色卡 JSON 解析失败: {e}"))?;

    // V2：{ spec: "chara_card_v2", data: { ... } }
    let is_v2 = raw
        .get("spec")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.contains("chara_card_v2"));
    let obj: &serde_json::Value = if is_v2 {
        raw.get("data").ok_or_else(|| "角色卡缺少 data 字段".to_string())?
    } else {
        &raw
    };

    let data: CardData = serde_json::from_value(obj.clone())
        .map_err(|e| format!("角色卡字段解析失败: {e}"))?;

    if data.name.trim().is_empty() {
        return Err("角色卡缺少角色名".to_string());
    }

    // 组装系统提示词
    let mut prompt_parts: Vec<String> = Vec::new();
    let push = |label: &str, text: &str, parts: &mut Vec<String>| {
        if !text.trim().is_empty() {
            parts.push(format!("【{label}】\n{}", text.trim()));
        }
    };
    push("角色设定", &data.description, &mut prompt_parts);
    push("性格", &data.personality, &mut prompt_parts);
    push("背景设定", &data.scenario, &mut prompt_parts);
    if !data.system_prompt.trim().is_empty() {
        prompt_parts.push(format!("【系统提示】\n{}", data.system_prompt.trim()));
    }
    push("对话后的额外指令", &data.post_history_instructions, &mut prompt_parts);
    push("示例对话", &data.mes_example, &mut prompt_parts);
    let system_prompt = prompt_parts.join("\n\n");

    let greeting = if !data.first_mes.trim().is_empty() {
        data.first_mes.trim().to_string()
    } else {
        data.alternate_greetings
            .first()
            .cloned()
            .unwrap_or_default()
            .trim()
            .to_string()
    };

    let agent = Agent {
        id: new_id(),
        name: data.name.trim().to_string(),
        emoji: "🤖".to_string(),
        color: "#576B95".to_string(),
        desc: truncate(&data.description, 60),
        system_prompt,
        greeting,
    };

    // 世界观条目
    let mut lore: Vec<LoreEntry> = Vec::new();
    if let Some(book) = &data.character_book {
        for e in &book.entries {
            if e.content.trim().is_empty() {
                continue;
            }
            let mut keys = e.keys.clone();
            keys.extend(e.secondary_keys.iter().cloned());
            keys.retain(|k| !k.trim().is_empty());
            let t = now_ms();
            lore.push(LoreEntry {
                id: new_id(),
                name: if e.name.trim().is_empty() { truncate(&e.content, 20) } else { e.name.trim().to_string() },
                keys,
                content: e.content.trim().to_string(),
                enabled: e.enabled.unwrap_or(true),
                constant: e.constant.unwrap_or(false),
                insertion_order: e.insertion_order.unwrap_or(0),
                created_at: t,
                updated_at: t,
            });
        }
    }

    Ok(ImportedCard { agent, lore })
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
}

/// 遍历 PNG 块，取 keyword 为 "chara" 的 tEXt/iTXt 文本
fn extract_chara_chunk(bytes: &[u8]) -> Result<String, String> {
    let mut off = 8usize;
    while off + 8 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]) as usize;
        if off + 12 + len > bytes.len() {
            break;
        }
        let kind = &bytes[off + 4..off + 8];
        let data = &bytes[off + 8..off + 8 + len];
        match kind {
            b"tEXt" => {
                if let Some(text) = parse_text_chunk(data, false)? {
                    return Ok(text);
                }
            }
            b"iTXt" => {
                if let Some(text) = parse_text_chunk(data, true)? {
                    return Ok(text);
                }
            }
            _ => {}
        }
        off += 12 + len;
    }
    Err("PNG 中未找到 chara 角色卡数据".to_string())
}

/// keyword NUL text（tEXt）；keyword NUL flag NUL method NUL lang NUL translated NUL text（iTXt）
fn parse_text_chunk(data: &[u8], is_itxt: bool) -> Result<Option<String>, String> {
    let nul = data.iter().position(|b| *b == 0).ok_or_else(|| "文本块格式错误".to_string())?;
    let keyword = &data[..nul];
    if keyword != b"chara" {
        return Ok(None);
    }
    let rest = &data[nul + 1..];
    if is_itxt {
        if rest.len() < 2 {
            return Err("iTXt 块格式错误".to_string());
        }
        let compressed = rest[0] == 1;
        if compressed {
            return Err("该角色卡使用了压缩 iTXt，请改用 JSON 格式导出".to_string());
        }
        let mut pos = 1;
        let lang_end = rest[pos..]
            .iter()
            .position(|b| *b == 0)
            .map(|i| pos + i)
            .ok_or_else(|| "iTXt 块格式错误".to_string())?;
        pos = lang_end + 1;
        let trans_end = rest[pos..]
            .iter()
            .position(|b| *b == 0)
            .map(|i| pos + i)
            .ok_or_else(|| "iTXt 块格式错误".to_string())?;
        pos = trans_end + 1;
        Ok(Some(String::from_utf8_lossy(&rest[pos..]).to_string()))
    } else {
        Ok(Some(String::from_utf8_lossy(rest).to_string()))
    }
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        let mut t: String = chars.into_iter().take(max).collect();
        t.push('…');
        t
    }
}
