//! 动作库数据模型 · 与前端 `src/types/exercise.ts` 对应。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 库内动作（含使用统计，供「最近使用」排序与列表展示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseRecord {
    pub id: String,
    pub name: String,
    /// 别名：旧数据按名匹配时的补充命中词（纯数据，展示不用）
    pub aliases: Vec<String>,
    /// strength | timed | cardio
    pub kind: String,
    /// push | pull | legs | core | cardio | mobility | other
    pub category: String,
    /// barbell | dumbbell | machine | cable | bodyweight | band | cardio | other
    pub equipment: Option<String>,
    /// 肌群激活表（ActivationMap：MuscleKey → 1~3）
    pub muscles: Value,
    pub tips: String,
    /// 动作要领（分步说明；空数组 = 未收录）
    pub steps: Vec<String>,
    /// 用户收藏（置顶展示；种子刷新不覆盖）
    pub favorite: bool,
    pub default_sets: i64,
    pub default_reps: Option<i64>,
    pub default_weight_kg: Option<f64>,
    pub default_target_sec: Option<i64>,
    pub default_duration_min: Option<i64>,
    pub default_rest_sec: i64,
    /// 建议重量取整步进（kg）；0 = 自重不加重量
    pub weight_step: f64,
    /// true = 用户自建（可改可删）；false = 内置（只读，仅可隐藏）
    pub is_custom: bool,
    pub hidden: bool,
    /// 有该动作做组记录的 distinct 训练次数
    pub sessions: i64,
    /// 最近一次做组的训练日期（YYYY-MM-DD）
    pub last_used_at: Option<String>,
}

/// 自建动作的新建 / 更新提交体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseInput {
    /// 缺省 = 新建（服务端生成 `custom-<uuid>`）；已有 id = 更新（仅限自建动作）
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub equipment: Option<String>,
    #[serde(default)]
    pub muscles: Value,
    #[serde(default)]
    pub tips: String,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default = "default_sets")]
    pub default_sets: i64,
    #[serde(default)]
    pub default_reps: Option<i64>,
    #[serde(default)]
    pub default_weight_kg: Option<f64>,
    #[serde(default)]
    pub default_target_sec: Option<i64>,
    #[serde(default)]
    pub default_duration_min: Option<i64>,
    #[serde(default = "default_rest")]
    pub default_rest_sec: i64,
    #[serde(default = "default_step")]
    pub weight_step: f64,
}

fn default_kind() -> String {
    "strength".into()
}

fn default_category() -> String {
    "other".into()
}

fn default_sets() -> i64 {
    3
}

fn default_rest() -> i64 {
    90
}

fn default_step() -> f64 {
    2.5
}
