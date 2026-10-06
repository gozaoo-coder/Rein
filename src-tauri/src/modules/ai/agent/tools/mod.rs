//! Rust 侧工具注册表（Phase 4 渐进迁移）。
//!
//! 约定：**Rust 优先，未注册回退前端桥接**。执行器（`commands.rs` 的
//! HybridExecutor）先查这里的 `run_tool`，返回 `None`（工具还没搬）才走
//! 「事件 → 前端注册表 → ai_agent_tool_result」。请求 defs 同理：
//! [`defs_for_groups`] 给出已迁移工具的 schema，与前端传来的 `params.tools`
//! 按名去重合并 —— 前端在对应 TS 工具文件删除前后都无需改一行。
//!
//! 新搬一个工具的完整路径：
//! 1. 在对应域子模块写 `fn def() -> RegisteredTool` + `async fn run(app, args) -> Result<Value>`；
//! 2. 在 [`registry()`] 静态表登记；
//! 3. 组名沿用前端 `ToolGroup`（registry.ts），装载策略仍由前端 resolveToolPlan 决定。

pub mod misc;
pub mod web;

use serde_json::Value;
use tauri::Manager;

use crate::error::Result;

use super::llm::LlmToolDef;
use super::models::ToolOutcome;

/// 一个已迁移到 Rust 的工具
#[derive(Debug, Clone)]
pub struct RegisteredTool {
    pub name: &'static str,
    /// 前端 ToolGroup 同名（装载策略在前端 resolveToolPlan）
    pub group: &'static str,
    /// 中文短名（UI 过程卡展示）
    pub label: &'static str,
    pub description: &'static str,
    /// JSON Schema（对齐 TS defineTool 的 TypeBox 形状）
    pub parameters: Value,
}

impl RegisteredTool {
    pub fn def(&self) -> LlmToolDef {
        LlmToolDef {
            name: self.name.to_string(),
            description: self.description.to_string(),
            parameters: self.parameters.clone(),
        }
    }
}

/// 已迁移工具的清单（随批次增长；每次构造，schema 都是小 JSON，开销可忽略）
pub fn registry() -> Vec<RegisteredTool> {
    vec![misc::search_history(), web::web_search_def(), web::web_fetch_def()]
}

/// 按组取工具 defs（保持登记顺序）
pub fn defs_for_groups(groups: &[String]) -> Vec<LlmToolDef> {
    registry()
        .iter()
        .filter(|t| groups.iter().any(|g| g == t.group))
        .map(|t| t.def())
        .collect()
}

/// 执行一个工具；`None` = 未注册（调用方回退前端桥接）。
///
/// 失败收敛为 `is_error: true` 的结果（模型据此自纠正），不抛 IPC 错误 ——
/// 与前端注册表「失败 throw 由框架回灌错误」的语义一致。
pub async fn run_tool(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<ToolOutcome> {
    // 各域实现需要的 State 从 app 现取（任务里 app 是 'static 的）
    let outcome = match name {
        misc::SEARCH_HISTORY_NAME => Some(misc::run(app, args).await),
        web::WEB_SEARCH_NAME | web::WEB_FETCH_NAME => Some(web::run(app, name, args).await),
        _ => None,
    }?;
    Some(match outcome {
        Ok(v) => ToolOutcome::ok(v.to_string()),
        Err(e) => ToolOutcome::error(e.to_string()),
    })
}

/* ---------- 共享小工具（各域复用） ---------- */

/// 读对象字段里的有限数值；`default` 在缺省/非法时生效
pub(crate) fn num_arg(args: &Value, key: &str, default: f64) -> f64 {
    args.get(key).and_then(|v| v.as_f64()).filter(|v| v.is_finite()).unwrap_or(default)
}

/// 结果投影统一 JSON 化（serde_json::json! 直接构造则无需此函数）
pub(crate) fn to_outcome_json(v: Result<Value>) -> Result<Value> {
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_unique_names_and_known_groups() {
        let reg = registry();
        assert!(reg.len() >= 3, "首批至少 3 个工具");
        let mut names: Vec<_> = reg.iter().map(|t| t.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), reg.len(), "工具名不得重复");
        for t in reg {
            assert!(!t.group.is_empty());
            assert!(t.parameters.is_object(), "{} 的 parameters 应为 JSON Schema object", t.name);
            assert!(t.parameters["type"] == "object", "{} 缺 type:object", t.name);
            assert!(!t.description.is_empty());
        }
    }

    #[test]
    fn defs_for_groups_filters_and_maps() {
        let defs = defs_for_groups(&["web".to_string()]);
        assert_eq!(defs.len(), 2, "web 组应有 web_search + web_fetch");
        assert!(defs.iter().any(|d| d.name == "web_search"));
        assert!(defs.iter().any(|d| d.name == "web_fetch"));
        assert!(defs_for_groups(&["nonexistent".to_string()]).is_empty());
        // schema 直通：发给 LLM 的 parameters 就是注册的 JSON Schema
        let def = defs.iter().find(|d| d.name == "web_search").unwrap();
        assert_eq!(def.parameters["properties"]["query"]["type"], "string");
    }

    #[test]
    fn num_arg_defaults_on_missing_or_invalid() {
        let args = serde_json::json!({ "a": 5, "b": "x", "c": null });
        assert_eq!(num_arg(&args, "a", 8.0), 5.0);
        assert_eq!(num_arg(&args, "b", 8.0), 8.0);
        assert_eq!(num_arg(&args, "c", 8.0), 8.0);
        assert_eq!(num_arg(&args, "missing", 8.0), 8.0);
    }
}
