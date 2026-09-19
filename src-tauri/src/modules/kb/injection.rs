//! 全量注入区：系统提示词 + 用户记忆（docs/ai-workspace.md §3.4）。
//!
//! 与「检索按需」相对的另一半：这两个目录的内容**每轮对话全量进系统提示词**，
//! 其余一切内容都必须靠工具（search_knowledge / read_knowledge / glob_knowledge）按需取。
//!
//! 预算与优先级：总长 ≤ `BUDGET_CHARS`，超限按
//! 「系统提示词 > 用户记忆/角色设定.md > 用户记忆/全局规范.md > 其他用户记忆」截断，
//! 并置 `truncated` 让提示词里注明「有内容没进去，需要时自己去读」。
//!
//! 只含 HTML 注释的文件（用户记忆的模板占位）不参与注入——它在文件树里可见、可编辑，
//! 但不会每轮白占预算。

use rusqlite::Connection;

use crate::error::Result;

use super::models::{KbInjection, KbInjectionFile, SYSTEM_PROMPT_ROOT, USER_MEMORY_ROOT};

/// 注入区总预算（字符）。12k 字符 ≈ 6k token，对长上下文模型是零头，对小模型是硬约束。
pub const BUDGET_CHARS: usize = 12_000;

/// 去掉 HTML 注释与空行后仍有内容才算「值得注入」。
fn meaningful(content: &str) -> Option<String> {
    let mut out = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || (t.starts_with("<!--") && t.ends_with("-->")) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    let t = out.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// 注入优先级：数字越小越先吃预算。
fn priority(path: &str) -> i32 {
    if path.starts_with(&format!("{SYSTEM_PROMPT_ROOT}/")) {
        return 0;
    }
    if path == format!("{USER_MEMORY_ROOT}/角色设定.md") {
        return 1;
    }
    if path == format!("{USER_MEMORY_ROOT}/全局规范.md") {
        return 2;
    }
    3
}

struct Entry {
    path: String,
    zone: String,
    content: String,
}

fn load(conn: &Connection) -> Result<Vec<Entry>> {
    let mut stmt = conn.prepare(
        "SELECT path, content FROM kb_files
         WHERE path LIKE ?1 || '/%' OR path LIKE ?2 || '/%'
         ORDER BY path",
    )?;
    let rows = stmt.query_map([SYSTEM_PROMPT_ROOT, USER_MEMORY_ROOT], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out: Vec<Entry> = Vec::new();
    for row in rows {
        let (path, content) = row?;
        let Some(content) = meaningful(&content) else {
            continue;
        };
        let zone = if path.starts_with(&format!("{SYSTEM_PROMPT_ROOT}/")) {
            "system"
        } else {
            "memory"
        };
        out.push(Entry {
            path,
            zone: zone.to_string(),
            content,
        });
    }
    // 优先级稳定排序：同级按路径（读取顺序已经按 path 排好，sort_by_key 是稳定排序）
    out.sort_by_key(|e| priority(&e.path));
    Ok(out)
}

/// 组装注入块。
pub fn build(conn: &Connection) -> Result<KbInjection> {
    let entries = load(conn)?;
    let mut used = 0usize;
    let mut truncated = false;
    let mut system = String::new();
    let mut memory = String::new();
    let mut files: Vec<KbInjectionFile> = Vec::new();

    for e in entries {
        if used >= BUDGET_CHARS {
            truncated = true;
            break;
        }
        let header = format!("【{}】\n", e.path);
        let budget_left = BUDGET_CHARS - used;
        let (text, cut) = if header.chars().count() + e.content.chars().count() <= budget_left {
            (format!("{header}{}\n", e.content), false)
        } else {
            truncated = true;
            let keep = budget_left.saturating_sub(header.chars().count() + 1);
            let clipped: String = e.content.chars().take(keep).collect();
            (format!("{header}{clipped}…\n"), true)
        };
        used += text.chars().count();
        match e.zone.as_str() {
            "system" => system.push_str(&text),
            _ => memory.push_str(&text),
        }
        files.push(KbInjectionFile {
            path: e.path,
            zone: e.zone,
            chars: e.content.chars().count() as i64,
            truncated: cut,
        });
        if cut {
            break;
        }
    }

    if truncated {
        let note =
            "（注入预算已满：还有内容没有注入，需要时用 glob_knowledge / read_knowledge 自己读）\n";
        if memory.is_empty() {
            system.push_str(note);
        } else {
            memory.push_str(note);
        }
        used += note.chars().count();
    }

    Ok(KbInjection {
        system,
        memory,
        files,
        total_chars: used as i64,
        budget: BUDGET_CHARS as i64,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::files;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        files::ensure_system_files(&conn).unwrap();
        conn
    }

    #[test]
    fn seeds_system_prompt_and_memory_templates() {
        let conn = db();
        let inj = build(&conn).unwrap();
        assert!(
            inj.system.contains("系统提示词/角色与语气.md"),
            "系统提示词文件必须进注入块：{}",
            inj.system
        );
        assert!(inj.system.contains("Rein AI"));
        assert!(!inj.truncated);
        // 模板（只有 HTML 注释）不占预算
        assert!(
            !inj.memory.contains("角色设定"),
            "纯注释模板不注入：{}",
            inj.memory
        );
        assert!(inj.budget == BUDGET_CHARS as i64);
    }

    #[test]
    fn user_memory_is_injected_in_priority_order() {
        let conn = db();
        files::write(
            &conn,
            "用户记忆/角色设定.md",
            "用户是一名程序员，喜欢简洁。",
        )
        .unwrap();
        files::write(&conn, "用户记忆/全局规范.md", "回答一律用简体中文。").unwrap();
        files::write(&conn, "用户记忆/其他.md", "补充材料").unwrap();

        let inj = build(&conn).unwrap();
        let pos_user = inj.memory.find("程序员").unwrap();
        let pos_global = inj.memory.find("简体中文").unwrap();
        let pos_other = inj.memory.find("补充材料").unwrap();
        assert!(
            pos_user < pos_global && pos_global < pos_other,
            "优先级顺序不对"
        );
        assert_eq!(inj.files[0].zone, "system", "系统提示词永远先吃预算");
    }

    #[test]
    fn budget_truncates_and_flags() {
        let conn = db();
        let huge = "很长的规范。".repeat(4000); // 24000+ 字，超过 12k 预算
        files::write(&conn, "用户记忆/角色设定.md", &huge).unwrap();
        files::write(&conn, "用户记忆/全局规范.md", "这条应该在截断之后被放弃").unwrap();

        let inj = build(&conn).unwrap();
        assert!(inj.truncated);
        assert!(inj.total_chars as usize <= BUDGET_CHARS + 120, "预算要守住");
        assert!(!inj.memory.contains("这条应该在截断之后被放弃"));
        assert!(inj.memory.contains("注入预算已满"));
        assert!(inj.files.iter().any(|f| f.truncated));
    }

    #[test]
    fn injected_content_never_leaks_base64() {
        // 上传的本体不进注入区（只有文本模态的文件才是 kb_files 行）
        let conn = db();
        files::write(&conn, "用户记忆/角色设定.md", "喜欢晨练").unwrap();
        let inj = build(&conn).unwrap();
        assert!(!inj.memory.contains("base64"));
        assert!(inj.memory.contains("喜欢晨练"));
    }
}
