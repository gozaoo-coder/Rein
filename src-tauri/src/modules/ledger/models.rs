//! 记账域数据模型 · 与前端 `src/types/ledger.ts` 对应。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub id: i64,
    /// expense | income
    pub kind: String,
    /// 分类 key（前端 src/config/ledger.ts）
    pub category: String,
    /// 金额（分，避免浮点误差）
    pub amount_cents: i64,
    pub note: Option<String>,
    /// YYYY-MM-DD
    pub date: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryInput {
    pub kind: String,
    pub category: String,
    pub amount_cents: i64,
    pub note: Option<String>,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSettings {
    pub id: i64,
    /// 0 = 未设置月度总预算
    pub monthly_budget_cents: i64,
    pub updated_at: Option<String>,
}
