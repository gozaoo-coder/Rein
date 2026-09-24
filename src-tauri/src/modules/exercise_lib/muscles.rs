//! 肌群键白名单与清洗。
//!
//! 与前端 `src/config/muscles.ts` 的 `MUSCLE_KEYS` 一一对应（顺序也一致）。
//! 漂移由 `seed.rs` 的单测用 `resources/exercises.json` 里的 `muscleKeys`
//! 元数据把守：生成器改了键、这边没跟上，`cargo test` 立刻红。

use serde_json::{Map, Value};

/// 全部合法肌群键（39 个：26 个浅/深层主键 + 13 个深层结构与补充肌束）
pub const MUSCLE_KEYS: &[&str] = &[
    "scm",
    "delt-ant",
    "delt-lat",
    "delt-post",
    "traps-up",
    "traps-mid",
    "traps-low",
    "lats",
    "lower-back",
    "chest-up",
    "chest-low",
    "abs",
    "obliques",
    "biceps",
    "triceps",
    "forearm",
    "glute-max",
    "glute-med",
    "quads-lat",
    "quads-rec",
    "quads-med",
    "adductors",
    "hamstrings",
    "calves",
    "soleus",
    "tibialis",
    "teres-major",
    "rhomboids",
    "rotator-cuff",
    "serratus-ant",
    "iliopsoas",
    "glute-min",
    "vastus-intermedius",
    "levator-scapulae",
    "tibialis-post",
    "fibularis",
    "plantaris",
    "popliteus",
    "quadratus-femoris",
];

/// 是否为合法肌群键
pub fn is_muscle_key(key: &str) -> bool {
    MUSCLE_KEYS.contains(&key)
}

/// 清洗肌群激活表：丢掉未知键、档位只保留 1~3（接受数字或数字字符串），
/// 非对象输入返回空对象。与前端 `normalizeActivation` 同语义。
pub fn sanitize_muscles(value: &Value) -> Value {
    let mut out = Map::new();
    if let Some(obj) = value.as_object() {
        for (key, raw) in obj {
            if !is_muscle_key(key) {
                continue;
            }
            let level = raw
                .as_i64()
                .or_else(|| raw.as_str().and_then(|s| s.trim().parse::<i64>().ok()));
            match level {
                Some(1) => out.insert(key.clone(), Value::from(1)),
                Some(2) => out.insert(key.clone(), Value::from(2)),
                Some(3) => out.insert(key.clone(), Value::from(3)),
                _ => None,
            };
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_drops_unknown_keys_and_bad_levels() {
        let cleaned = sanitize_muscles(&json!({
            "delt-ant": 3,
            "not-a-muscle": 3,
            "chest-low": 0,
            "traps-up": 9,
            "lats": "2",
            "abs": true,
        }));
        assert_eq!(cleaned, json!({ "delt-ant": 3, "lats": 2 }));
    }

    #[test]
    fn sanitize_non_object_is_empty() {
        assert_eq!(sanitize_muscles(&json!(null)), json!({}));
        assert_eq!(sanitize_muscles(&json!([1, 2])), json!({}));
        assert_eq!(sanitize_muscles(&json!("delt-ant")), json!({}));
    }
}
