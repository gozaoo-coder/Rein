//! 动作要领（分步说明）的清洗。
//!
//! 数据来源有两类：内置种子（生成器手写/导入管线）与用户或 AI 提交。
//! 两条路径都在这里过一遍，保证库里存的永远是「干净的字符串数组」。

use serde_json::Value;

/// 最多保留的步数
pub const MAX_STEPS: usize = 12;
/// 单步最大字数（超出截断，避免把整篇教程塞进列表）
pub const MAX_STEP_CHARS: usize = 200;

/// 清洗分步要领：去首尾空白、丢空串、截断超长、最多 12 条
pub fn sanitize_steps(steps: &[String]) -> Vec<String> {
    steps
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .take(MAX_STEPS)
        .map(|s| s.chars().take(MAX_STEP_CHARS).collect::<String>())
        .collect()
}

/// 从任意 JSON 值清洗（种子/导入数据是数组，非法输入退化为空数组）
pub fn sanitize_steps_value(v: &Value) -> Vec<String> {
    let list: Vec<String> = v
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    sanitize_steps(&list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn drops_empty_and_caps_length() {
        let long = "字".repeat(MAX_STEP_CHARS + 50);
        let cleaned = sanitize_steps(&[
            "  握住杠铃  ".to_string(),
            "".to_string(),
            "   ".to_string(),
            long,
        ]);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0], "握住杠铃");
        assert_eq!(cleaned[1].chars().count(), MAX_STEP_CHARS);
    }

    #[test]
    fn caps_step_count() {
        let many: Vec<String> = (0..20).map(|i| format!("第 {i} 步")).collect();
        assert_eq!(sanitize_steps(&many).len(), MAX_STEPS);
    }

    #[test]
    fn non_array_json_becomes_empty() {
        assert!(sanitize_steps_value(&json!(null)).is_empty());
        assert!(sanitize_steps_value(&json!("不是数组")).is_empty());
        assert_eq!(
            sanitize_steps_value(&json!([" 一步 ", 42, "两步"])),
            vec!["一步".to_string(), "两步".to_string()]
        );
    }
}
