//! AI 域命令 · 命令名与前端 `aiService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;

use super::models::ParsedFoodItem;

const QUANT_WORDS: [char; 12] = [
    '个', '碗', '杯', '根', '片', '块', '勺', '份', '颗', '把', '盒', '支',
];

fn cn_num(c: char) -> Option<f64> {
    match c {
        '半' => Some(0.5),
        '一' => Some(1.0),
        '二' | '两' => Some(2.0),
        '三' => Some(3.0),
        '四' => Some(4.0),
        '五' => Some(5.0),
        '六' => Some(6.0),
        '七' => Some(7.0),
        '八' => Some(8.0),
        '九' => Some(9.0),
        '十' => Some(10.0),
        _ => None,
    }
}

/// 关键词解析：食物库逐个匹配名称（去掉括号后缀），
/// 就近向前看 8 个字符，识别「200克」或「一个/一碗」等数量词。
#[tauri::command]
pub fn ai_parse_food_text(state: State<AppState>, text: String) -> Result<Vec<ParsedFoodItem>> {
    let conn = state.db.lock().unwrap();

    let mut stmt =
        conn.prepare("SELECT id, name, default_unit FROM foods ORDER BY LENGTH(name) DESC")?;
    let foods: Vec<(i64, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let chars: Vec<char> = text.chars().collect();
    let mut items: Vec<ParsedFoodItem> = Vec::new();

    for (id, name, default_unit) in foods {
        if items.len() >= 6 {
            break;
        }
        let base: String = name.split('(').next().unwrap_or(&name).to_string();
        let base_chars: Vec<char> = base.chars().collect();
        if base_chars.is_empty() {
            continue;
        }

        // 名称命中位置
        let mut pos: Option<usize> = None;
        for i in 0..=chars.len().saturating_sub(base_chars.len()) {
            if chars[i..i + base_chars.len()] == base_chars[..] {
                pos = Some(i);
                break;
            }
        }
        let pos = match pos {
            Some(p) => p,
            None => continue,
        };
        if items.iter().any(|it| it.food_id == Some(id)) {
            continue;
        }

        // 就近数量词
        let lookback = 8.min(pos);
        let before: Vec<char> = chars[pos - lookback..pos].to_vec();
        let mut grams = default_grams(&conn, id, default_unit.as_deref())?;

        // ① 数字 + 克/g（紧邻名称）
        let mut digits_end = before.len();
        while digits_end > 0 && before[digits_end - 1].is_ascii_digit() {
            digits_end -= 1;
        }
        if digits_end < before.len() {
            let num: f64 = before[digits_end..]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0.0);
            let has_unit_char =
                digits_end > 0 && matches!(before[digits_end - 1], '克' | 'g' | 'G');
            if has_unit_char || (num > 0.0 && num <= 2000.0) {
                grams = num;
            }
        } else if let Some(last) = before.last().copied() {
            // ② 中文数字 + 量词
            if QUANT_WORDS.contains(&last) && before.len() >= 2 {
                if let Some(count) = cn_num(before[before.len() - 2]) {
                    grams = unit_grams(&conn, id, &last.to_string())?.unwrap_or(grams) * count;
                }
            }
        }

        items.push(ParsedFoodItem {
            food_id: Some(id),
            food_name: base,
            grams,
            kcal_estimate: (kcal_per_100g(&conn, id)? * grams / 100.0).round(),
            confidence: 0.6,
            note: None,
        });
    }

    Ok(items)
}

/* ---------- 辅助查询 ---------- */
// 拍照解析由前端 pi-ai 直连视觉模型完成（src/ai/foodPhoto.ts），不经过 Rust。

fn kcal_per_100g(conn: &rusqlite::Connection, food_id: i64) -> Result<f64> {
    Ok(
        conn.query_row("SELECT kcal FROM foods WHERE id = ?1", [food_id], |r| {
            r.get(0)
        })?,
    )
}

fn unit_grams(conn: &rusqlite::Connection, food_id: i64, name: &str) -> Result<Option<f64>> {
    let res = conn.query_row(
        "SELECT grams FROM food_units WHERE food_id = ?1 AND name = ?2",
        rusqlite::params![food_id, name],
        |r| r.get(0),
    );
    match res {
        Ok(grams) => Ok(Some(grams)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn default_grams(
    conn: &rusqlite::Connection,
    food_id: i64,
    default_unit: Option<&str>,
) -> Result<f64> {
    if let Some(u) = default_unit {
        if let Some(g) = unit_grams(conn, food_id, u)? {
            return Ok(g);
        }
    }
    Ok(100.0)
}

/* ---------- 目标调整解析 ---------- */

use super::models::{TargetAdjustProposal, TargetChange};
use crate::modules::nutrition::models::DailyTargets;

/// 字段规格：关键词 → 目标字段（界限与取整粒度与前端 NumberStepper 一致）
struct FieldSpec {
    field: &'static str,
    label: &'static str,
    unit: &'static str,
    keywords: &'static [&'static str],
    min: f64,
    max: f64,
    round_step: f64,
}

const FIELD_SPECS: [FieldSpec; 6] = [
    FieldSpec {
        field: "kcal",
        label: "能量",
        unit: "大卡",
        keywords: &["热量", "大卡", "千卡", "卡路里", "kcal"],
        min: 800.0,
        max: 5000.0,
        round_step: 10.0,
    },
    FieldSpec {
        field: "protein",
        label: "蛋白质",
        unit: "g",
        keywords: &["蛋白"],
        min: 20.0,
        max: 300.0,
        round_step: 1.0,
    },
    FieldSpec {
        field: "carb",
        label: "碳水",
        unit: "g",
        keywords: &["碳水"],
        min: 50.0,
        max: 600.0,
        round_step: 1.0,
    },
    FieldSpec {
        field: "fat",
        label: "脂肪",
        unit: "g",
        keywords: &["脂肪"],
        min: 20.0,
        max: 200.0,
        round_step: 1.0,
    },
    FieldSpec {
        field: "sodiumMg",
        label: "钠",
        unit: "mg",
        keywords: &["钠", "盐"],
        min: 500.0,
        max: 5000.0,
        round_step: 50.0,
    },
    FieldSpec {
        field: "waterMl",
        label: "饮水",
        unit: "ml",
        keywords: &["饮水", "喝水", "水"],
        min: 500.0,
        max: 5000.0,
        round_step: 100.0,
    },
];

const UP_WORDS: [&str; 5] = ["提高", "提升", "增加", "上调", "多"];
const DOWN_WORDS: [&str; 6] = ["降低", "降到", "减少", "下调", "少", "控制"];

/// 方向词后紧跟「到/为/成/至」视为绝对值（"降到1700"），否则为增量（"减少300"）。
const ABSOLUTE_PARTICLES: [char; 5] = ['到', '为', '成', '至', '在'];

fn read_number(chars: &[char], start: usize) -> Option<(f64, usize)> {
    let mut i = start;
    let mut seen_dot = false;
    while i < chars.len() && (chars[i].is_ascii_digit() || (chars[i] == '.' && !seen_dot)) {
        if chars[i] == '.' {
            seen_dot = true;
        }
        i += 1;
    }
    if i == start {
        return None;
    }
    let s: String = chars[start..i].iter().collect();
    s.parse().ok().map(|v| (v, i))
}

/// 从 `from` 起向后跳过至多 `skip_limit` 个非数字字符找数
fn number_forward(chars: &[char], from: usize, skip_limit: usize) -> Option<(f64, usize, usize)> {
    let end = chars.len().min(from + skip_limit);
    let mut i = from;
    while i < end {
        if chars[i].is_ascii_digit() {
            let (v, num_end) = read_number(chars, i)?;
            return Some((v, i, num_end));
        }
        i += 1;
    }
    None
}

/// 从 `before` 往前至多 `window` 个字符里找数字串的末尾并读出该数（如"1800大卡"）
fn number_backward(chars: &[char], before: usize, window: usize) -> Option<(f64, usize, usize)> {
    let lo = before.saturating_sub(window);
    let mut i = before;
    while i > lo {
        i -= 1;
        if chars[i].is_ascii_digit() || chars[i] == '.' {
            // 回退到数字串起点（含小数点）
            let mut start = i;
            while start > 0 && (chars[start - 1].is_ascii_digit() || chars[start - 1] == '.') {
                start -= 1;
            }
            let (v, _) = read_number(chars, start)?;
            return Some((v, start, i + 1));
        }
    }
    None
}

/// 数字前的上下文窗口：判定调整方向。
/// 返回 +1/-1 表示「提高/降低 N」的增量；0 表示绝对值语义（"降到1700"、"蛋白质130克"）。
fn direction_before(chars: &[char], num_start: usize) -> i32 {
    let ws = num_start.saturating_sub(8);
    let ctx: String = chars[ws..num_start].iter().collect();
    // 方向词后紧跟「到/为/成/至/在」（允许中间空白）时按绝对目标理解
    let trimmed = ctx.trim_end();
    let particle = trimmed
        .chars()
        .next_back()
        .is_some_and(|c| ABSOLUTE_PARTICLES.contains(&c));
    if particle {
        return 0;
    }
    if UP_WORDS.iter().any(|w| ctx.contains(w)) {
        1
    } else if DOWN_WORDS.iter().any(|w| ctx.contains(w)) {
        -1
    } else {
        0
    }
}

fn clamp_round(v: f64, spec: &FieldSpec) -> f64 {
    let clamped = v.clamp(spec.min, spec.max);
    (clamped / spec.round_step).round() * spec.round_step
}

fn current_of(t: &DailyTargets, field: &str) -> f64 {
    match field {
        "kcal" => t.kcal,
        "protein" => t.protein,
        "carb" => t.carb,
        "fat" => t.fat,
        "sodiumMg" => t.sodium_mg,
        _ => t.water_ml,
    }
}

fn assign(targets: &mut DailyTargets, field: &str, value: f64) {
    match field {
        "kcal" => targets.kcal = value,
        "protein" => targets.protein = value,
        "carb" => targets.carb = value,
        "fat" => targets.fat = value,
        "sodiumMg" => targets.sodium_mg = value,
        _ => targets.water_ml = value,
    }
}

/// 自然语言 → 每日目标调整建议。关键词占位实现：
/// 「把热量降到1800」「蛋白质提高到130克」「每天1800大卡」；接入 LLM 后替换内部实现。
#[tauri::command]
pub fn ai_parse_target_adjust(text: String, current: DailyTargets) -> Result<TargetAdjustProposal> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut proposal = current.clone();
    let mut changes: Vec<TargetChange> = Vec::new();
    let mut done_fields: Vec<&'static str> = Vec::new();

    for spec in &FIELD_SPECS {
        if done_fields.contains(&spec.field) {
            continue;
        }
        for kw in spec.keywords {
            // 关键词在原文中的位置（lowercase 与原文同字符长度，仅 ASCII 受影响）
            let kw_chars: Vec<char> = kw.to_lowercase().chars().collect();
            let len = kw_chars.len();
            let mut pos: Option<usize> = None;
            for i in 0..=chars.len().saturating_sub(len) {
                if chars[i..i + len] == kw_chars[..] {
                    pos = Some(i);
                    break;
                }
            }
            let pos = match pos {
                Some(p) => p,
                None => continue,
            };
            // 裸「水」排除「水果」等复合词
            if *kw == "水" && chars.get(pos + 1).is_some_and(|&c| c == '果') {
                continue;
            }

            // 数值优先在关键词之后（"热量降到1800"），其次之前（"1800大卡"）
            let found =
                number_forward(&chars, pos + len, 6).or_else(|| number_backward(&chars, pos, 6));
            let (value, num_start) = match found {
                Some((v, ns, _)) => (v, ns),
                None => continue,
            };

            let sign = direction_before(&chars, num_start);
            let from = current_of(&current, spec.field);
            let to = if sign != 0 {
                from + sign as f64 * value
            } else {
                // 绝对语义或无方向词：就近数值按新目标理解
                value
            };
            let to = clamp_round(to, spec);
            if (to - from).abs() < f64::EPSILON {
                continue;
            }
            assign(&mut proposal, spec.field, to);
            changes.push(TargetChange {
                field: spec.field.to_string(),
                label: spec.label.to_string(),
                unit: spec.unit.to_string(),
                from,
                to,
            });
            done_fields.push(spec.field);
            break;
        }
    }

    let reply = if changes.is_empty() {
        "没有从这句话里识别出要调整的目标。可以这样说：「把热量降到 1800 大卡」「蛋白质提高到 130 克」。".to_string()
    } else {
        format!(
            "已根据你的描述整理出 {} 项目标调整，确认后立即生效。",
            changes.len()
        )
    };

    Ok(TargetAdjustProposal {
        targets: proposal,
        changes,
        reply,
    })
}

/* ---------- 模型配置（存储层；请求由前端 pi-ai 直连 provider） ---------- */

use chrono::Utc;

use crate::error::ReinError;

use super::models::{
    AiChat, AiChatMessage, AiChatMessageInput, AiModel, AiModelInput, AiProbeResult, AiUsageByModel,
    AiUsageDay, AiUsageInput, AiUsageSummary, AiUsageTotals, ChatSearchHit,
};

pub(super) const AI_MODEL_COLS: &str =
    "id, name, provider, base_url, api_key, model_id, is_default, vision, thinking, effort, image_max_edge, last_error, \
     source, service_base, price_in, price_out, price_currency, traffic_per_gb, created_at, updated_at";

pub(super) fn ai_model_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiModel> {
    Ok(AiModel {
        id: row.get(0)?,
        name: row.get(1)?,
        provider: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
        model_id: row.get(5)?,
        is_default: row.get::<_, i64>(6)? != 0,
        vision: row.get(7)?,
        thinking: row.get(8)?,
        effort: row.get(9)?,
        image_max_edge: row.get(10)?,
        last_error: row.get(11)?,
        source: row.get(12)?,
        service_base: row.get(13)?,
        price_in: row.get(14)?,
        price_out: row.get(15)?,
        price_currency: row.get(16)?,
        traffic_per_gb: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

fn validate_ai_model(input: &AiModelInput) -> Result<()> {
    for (label, v) in [
        ("名称", &input.name),
        ("接口地址", &input.base_url),
        ("API Key", &input.api_key),
        ("模型 ID", &input.model_id),
    ] {
        if v.trim().is_empty() {
            return Err(ReinError::Message(format!("{label}不能为空")));
        }
    }
    Ok(())
}

/// 模型列表：默认模型置顶。
#[tauri::command]
pub fn ai_model_list(state: State<AppState>) -> Result<Vec<AiModel>> {
    let conn = state.db.lock().unwrap();
    let sql = format!("SELECT {AI_MODEL_COLS} FROM ai_models ORDER BY is_default DESC, id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let models = stmt
        .query_map([], ai_model_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(models)
}

/// 添加模型：库为空时强制设为默认；设为默认则清空其他默认。
#[tauri::command]
pub fn ai_model_add(state: State<AppState>, input: AiModelInput) -> Result<AiModel> {
    validate_ai_model(&input)?;
    let now = Utc::now().to_rfc3339();
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM ai_models", [], |r| r.get(0))?;
    let make_default = input.is_default || count == 0;
    if make_default {
        tx.execute("UPDATE ai_models SET is_default = 0", [])?;
    }
    tx.execute(
        "INSERT INTO ai_models (name, provider, base_url, api_key, model_id, is_default, image_max_edge, price_in, price_out, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            input.name,
            input.provider,
            input.base_url,
            input.api_key,
            input.model_id,
            make_default as i64,
            input.image_max_edge,
            input.price_in,
            input.price_out,
            now
        ],
    )?;
    let id = tx.last_insert_rowid();
    let sql = format!("SELECT {AI_MODEL_COLS} FROM ai_models WHERE id = ?1");
    let model = tx.query_row(&sql, [id], ai_model_from_row)?;
    tx.commit()?;
    Ok(model)
}

/// 全量更新；探测结果失效清空（模型/地址变化后由前端重新探测）。
#[tauri::command]
pub fn ai_model_update(state: State<AppState>, id: i64, input: AiModelInput) -> Result<()> {
    validate_ai_model(&input)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_models WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(ReinError::Message("模型不存在".into()));
    }
    if input.is_default {
        tx.execute("UPDATE ai_models SET is_default = 0", [])?;
    }
    let now = Utc::now().to_rfc3339();
    // online 模型的单价以服务端为准（同步时写入），这里不覆盖；手动模型的单价可随手填改
    tx.execute(
        "UPDATE ai_models SET name = ?1, provider = ?2, base_url = ?3, api_key = ?4, \
         model_id = ?5, is_default = ?6, vision = NULL, thinking = NULL, effort = NULL, \
         image_max_edge = ?7, last_error = NULL, \
         price_in = CASE WHEN source = 'online' THEN price_in ELSE ?9 END, \
         price_out = CASE WHEN source = 'online' THEN price_out ELSE ?10 END, \
         updated_at = ?8 WHERE id = ?11",
        rusqlite::params![
            input.name,
            input.provider,
            input.base_url,
            input.api_key,
            input.model_id,
            input.is_default as i64,
            input.image_max_edge,
            now,
            input.price_in,
            input.price_out,
            id
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// 删除模型：若删的是默认且仍有剩余，自动把最早一条提升为默认。
#[tauri::command]
pub fn ai_model_delete(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM ai_models WHERE id = ?1", [id])?;
    let has_default: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_models WHERE is_default = 1)",
        [],
        |r| r.get(0),
    )?;
    if !has_default {
        conn.execute(
            "UPDATE ai_models SET is_default = 1 WHERE id = (SELECT MIN(id) FROM ai_models)",
            [],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn ai_model_set_default(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("UPDATE ai_models SET is_default = 0", [])?;
    let n = conn.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ReinError::Message("模型不存在".into()));
    }
    Ok(())
}

/// 写回探测结果（max_tokens=1 探测包，由前端执行）。
#[tauri::command]
pub fn ai_model_save_probe(state: State<AppState>, id: i64, result: AiProbeResult) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    let n = conn.execute(
        "UPDATE ai_models SET vision = ?1, thinking = ?2, effort = ?3, last_error = ?4, \
         updated_at = ?5 WHERE id = ?6",
        rusqlite::params![
            result.vision,
            result.thinking,
            result.effort,
            result.error,
            now,
            id
        ],
    )?;
    if n == 0 {
        return Err(ReinError::Message("模型不存在".into()));
    }
    Ok(())
}

/* ---------- 聊天历史 ---------- */

fn ai_chat_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiChat> {
    Ok(AiChat {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

/// 打开（不存在则创建）会话；前端固定使用 'main'。
#[tauri::command]
pub fn ai_chat_ensure(state: State<AppState>, id: String, title: Option<String>) -> Result<AiChat> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO ai_chats (id, title, created_at, updated_at) \
         VALUES (?1, COALESCE(?2, 'AI 对话'), ?3, ?3) ON CONFLICT(id) DO NOTHING",
        rusqlite::params![id, title, now],
    )?;
    Ok(conn.query_row(
        "SELECT id, title, created_at, updated_at FROM ai_chats WHERE id = ?1",
        [id],
        ai_chat_from_row,
    )?)
}

/// 会话消息（按 seq 升序）。
#[tauri::command]
pub fn ai_chat_messages(state: State<AppState>, chat_id: String) -> Result<Vec<AiChatMessage>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, seq, role, kind, text, image_base64, mime, payload, created_at \
         FROM ai_chat_messages WHERE chat_id = ?1 ORDER BY seq ASC",
    )?;
    let msgs = stmt
        .query_map([&chat_id], |r| {
            Ok(AiChatMessage {
                id: r.get(0)?,
                chat_id: r.get(1)?,
                seq: r.get(2)?,
                role: r.get(3)?,
                kind: r.get(4)?,
                text: r.get(5)?,
                image_base64: r.get(6)?,
                mime: r.get(7)?,
                payload: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(msgs)
}

/// 追加消息：按 id 幂等 upsert（重复调用或 commit 状态更新只刷新内容，
/// 保留原 seq 与 created_at），并刷新会话时间。
#[tauri::command]
pub fn ai_chat_append(
    state: State<AppState>,
    chat_id: String,
    input: AiChatMessageInput,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO ai_chats (id, created_at, updated_at) VALUES (?1, ?2, ?2) \
         ON CONFLICT(id) DO NOTHING",
        rusqlite::params![chat_id, now],
    )?;
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM ai_chat_messages WHERE chat_id = ?1",
        [&chat_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO ai_chat_messages \
         (id, chat_id, seq, role, kind, text, image_base64, mime, payload, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(id) DO UPDATE SET \
           role = excluded.role, kind = excluded.kind, text = excluded.text, \
           image_base64 = excluded.image_base64, mime = excluded.mime, payload = excluded.payload",
        rusqlite::params![
            input.id,
            chat_id,
            seq,
            input.role,
            input.kind,
            input.text,
            input.image_base64,
            input.mime,
            input.payload,
            now
        ],
    )?;
    conn.execute(
        "UPDATE ai_chats SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, chat_id],
    )?;
    Ok(())
}

/// 清空会话消息（会话保留）。
#[tauri::command]
pub fn ai_chat_clear(state: State<AppState>, chat_id: String) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    conn.execute(
        "DELETE FROM ai_chat_messages WHERE chat_id = ?1",
        [&chat_id],
    )?;
    conn.execute(
        "UPDATE ai_chats SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, chat_id],
    )?;
    Ok(())
}

/// 撤回：删除该消息及其后（按 seq 递增顺序）的所有消息，并刷新会话时间。
#[tauri::command]
pub fn ai_chat_cut(state: State<AppState>, chat_id: String, message_id: String) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    let n = conn.execute(
        "DELETE FROM ai_chat_messages WHERE chat_id = ?1 AND seq >= \
           (SELECT seq FROM ai_chat_messages WHERE chat_id = ?1 AND id = ?2)",
        rusqlite::params![chat_id, message_id],
    )?;
    if n > 0 {
        conn.execute(
            "UPDATE ai_chats SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, chat_id],
        )?;
    }
    Ok(())
}

/// 会话列表：按最近活动倒序（历史抽屉顶部 = 最新聊天）。
#[tauri::command]
pub fn ai_chat_list(state: State<AppState>) -> Result<Vec<AiChat>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at FROM ai_chats ORDER BY updated_at DESC, created_at DESC",
    )?;
    let chats = stmt
        .query_map([], ai_chat_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(chats)
}

/// 重命名会话（首个用户消息后由标题"AI 对话"改为前 16 字）。
#[tauri::command]
pub fn ai_chat_rename(state: State<AppState>, id: String, title: String) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ReinError::Message("会话标题不能为空".into()));
    }
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE ai_chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![title, now, id],
    )?;
    Ok(())
}

/// 跨会话全文搜索历史消息（AI 工具「搜索全部上下文」的后端）；最新命中优先。
#[tauri::command]
pub fn ai_chat_search(
    state: State<AppState>,
    keyword: String,
    limit: Option<i64>,
) -> Result<Vec<ChatSearchHit>> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(8).clamp(1, 50);
    let like = format!("%{keyword}%");
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT m.chat_id, c.title, m.seq, m.role, m.kind, m.text, m.created_at \
         FROM ai_chat_messages m JOIN ai_chats c ON c.id = m.chat_id \
         WHERE (m.text LIKE ?1 OR m.payload LIKE ?1) \
         ORDER BY m.created_at DESC LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(rusqlite::params![like, limit], |r| {
            Ok(ChatSearchHit {
                chat_id: r.get(0)?,
                chat_title: r.get(1)?,
                seq: r.get(2)?,
                role: r.get(3)?,
                kind: r.get(4)?,
                text: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(hits)
}

/* ---------- 本机成本账本（服务端另有权威账本，两边可对账） ---------- */

const AI_USAGE_SUM: &str = "COUNT(*) AS calls, \
     COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, \
     COALESCE(SUM(request_bytes),0) AS rb, COALESCE(SUM(response_bytes),0) AS ob, \
     COALESCE(SUM(cost_model_nano),0) AS cm, COALESCE(SUM(cost_traffic_nano),0) AS ctr, \
     COALESCE(SUM(cost_total_nano),0) AS ctot";

fn usage_totals_from_row(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<AiUsageTotals> {
    Ok(AiUsageTotals {
        calls: row.get(base)?,
        prompt_tokens: row.get(base + 1)?,
        completion_tokens: row.get(base + 2)?,
        request_bytes: row.get(base + 3)?,
        response_bytes: row.get(base + 4)?,
        cost_model_nano: row.get(base + 5)?,
        cost_traffic_nano: row.get(base + 6)?,
        cost_total_nano: row.get(base + 7)?,
    })
}

/// 记一笔用量：一轮对话一行。金额由前端按单价算好（服务端为权威口径，这里只记账）。
#[tauri::command]
pub fn ai_usage_record(state: State<AppState>, input: AiUsageInput) -> Result<()> {
    let conn = state.db.lock().unwrap();
    usage_record_on(&conn, &input)
}

pub(super) fn usage_record_on(conn: &rusqlite::Connection, input: &AiUsageInput) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_usage (ts, chat_id, model_pk, model_name, model_id, provider, source, \
         prompt_tokens, completion_tokens, request_bytes, response_bytes, \
         cost_model_nano, cost_traffic_nano, cost_total_nano, currency, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'CNY', ?15)",
        rusqlite::params![
            now,
            input.chat_id,
            input.model_pk,
            input.model_name,
            input.model_id,
            if input.provider.is_empty() { "openai-compatible".to_string() } else { input.provider.clone() },
            if input.source.is_empty() { "manual".to_string() } else { input.source.clone() },
            input.prompt_tokens,
            input.completion_tokens,
            input.request_bytes,
            input.response_bytes,
            input.cost_model_nano,
            input.cost_traffic_nano,
            input.cost_model_nano + input.cost_traffic_nano,
            input.note,
        ],
    )?;
    Ok(())
}

/// 本机成本汇总：累计 + 今日 + 按天 + 按模型（最近 N 天，默认 30）。
#[tauri::command]
pub fn ai_usage_summary(state: State<AppState>, days: Option<i64>) -> Result<AiUsageSummary> {
    let conn = state.db.lock().unwrap();
    usage_summary_on(&conn, days.unwrap_or(30).clamp(1, 365))
}

pub(super) fn usage_summary_on(conn: &rusqlite::Connection, days: i64) -> Result<AiUsageSummary> {
    let since = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    let today = Utc::now().format("%Y-%m-%d").to_string();

    let sql = format!("SELECT {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1");
    let total = conn.query_row(&sql, [since.as_str()], |r| usage_totals_from_row(r, 0))?;

    let today_sql = format!("SELECT {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1");
    let today_totals = conn.query_row(&today_sql, [today.as_str()], |r| usage_totals_from_row(r, 0))?;

    let day_sql = format!(
        "SELECT substr(ts, 1, 10) AS d, {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1 GROUP BY d ORDER BY d DESC"
    );
    let mut stmt = conn.prepare(&day_sql)?;
    let by_day = stmt
        .query_map([since.as_str()], |r| {
            Ok(AiUsageDay {
                date: r.get(0)?,
                totals: usage_totals_from_row(r, 1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // model_pk 可能指向已删除的模型：名称仍按记账时的快照聚合
    let model_sql = format!(
        "SELECT model_pk, model_name, model_id, source, {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1 \
         GROUP BY model_name, model_id, source ORDER BY ctot DESC"
    );
    let mut stmt = conn.prepare(&model_sql)?;
    let by_model = stmt
        .query_map([since.as_str()], |r| {
            Ok(AiUsageByModel {
                model_pk: r.get(0)?,
                model_name: r.get(1)?,
                model_id: r.get(2)?,
                source: r.get(3)?,
                totals: usage_totals_from_row(r, 4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(AiUsageSummary {
        days,
        since,
        today: today_totals,
        total,
        by_day,
        by_model,
    })
}

/// 清空本机账本（换机 / 重新对账时用；服务端的账不受影响）。
#[tauri::command]
pub fn ai_usage_clear(state: State<AppState>) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM ai_usage", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::migrate_for_test;

    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    /// 一条在线模型调用：100 万输入 token 的模型费 + 128MB 出方向流量费，金额由前端算好传进来
    fn usage(model_id: &str, model_name: &str, model_nano: i64, traffic_nano: i64) -> AiUsageInput {
        AiUsageInput {
            chat_id: Some("main".into()),
            model_pk: Some(1),
            model_name: model_name.into(),
            model_id: model_id.into(),
            provider: "rein-online".into(),
            source: "online".into(),
            prompt_tokens: 1_000_000,
            completion_tokens: 500,
            request_bytes: 1024,
            response_bytes: 128 * 1024 * 1024,
            cost_model_nano: model_nano,
            cost_traffic_nano: traffic_nano,
            note: None,
        }
    }

    /// 模型费与流量费要分开累计、合计到一起：这是「服务器流量 0.8 元/GB」能被看见的前提。
    #[test]
    fn model_and_traffic_cost_add_up_in_the_summary() {
        let conn = fresh();
        usage_record_on(
            &conn,
            &usage("deepseek-flash", "DeepSeek · deepseek-flash", 2_000_000_000, 102_400_000),
        )
        .unwrap();
        let mut second = usage("deepseek-v4-pro", "DeepSeek · deepseek-v4-pro", 1_000_000_000, 0);
        second.prompt_tokens = 100;
        usage_record_on(&conn, &second).unwrap();

        let s = usage_summary_on(&conn, 30).unwrap();
        assert_eq!(s.total.calls, 2);
        assert_eq!(s.total.cost_model_nano, 3_000_000_000, "模型费应累加两笔");
        assert_eq!(s.total.cost_traffic_nano, 102_400_000, "流量费单独累计");
        assert_eq!(s.total.cost_total_nano, 3_102_400_000, "合计 = 模型费 + 流量费");
        assert_eq!(s.total.prompt_tokens, 1_000_100);
        assert_eq!(s.today.calls, 2, "刚写入的两笔应算在今天");
        assert_eq!(s.by_day.len(), 1);
        assert_eq!(s.by_model.len(), 2, "两个模型各自一行");
        assert_eq!(s.by_model[0].model_id, "deepseek-flash", "按花费降序");
        assert_eq!(s.by_model[0].totals.cost_total_nano, 2_102_400_000);
    }

    /// 模型删了账不能丢：否则用户删掉一条模型，历史花费会凭空消失。
    #[test]
    fn usage_rows_outlive_the_model_they_referenced() {
        let conn = fresh();
        usage_record_on(&conn, &usage("gone", "已删除的模型", 1_000_000_000, 0)).unwrap();
        conn.execute("DELETE FROM ai_models", []).unwrap();
        let s = usage_summary_on(&conn, 30).unwrap();
        assert_eq!(s.total.calls, 1);
        assert_eq!(s.by_model[0].model_name, "已删除的模型");
    }

    /// 窗口外的记录不计入（默认 30 天）。
    #[test]
    fn window_excludes_older_rows() {
        let conn = fresh();
        usage_record_on(&conn, &usage("m", "M", 1_000_000_000, 0)).unwrap();
        conn.execute("UPDATE ai_usage SET ts = '2020-01-01T00:00:00+00:00'", [])
            .unwrap();
        let s = usage_summary_on(&conn, 30).unwrap();
        assert_eq!(s.total.calls, 0);
        assert_eq!(s.today.calls, 0);
        assert_eq!(usage_summary_on(&conn, 3650).unwrap().total.calls, 1);
    }
}

