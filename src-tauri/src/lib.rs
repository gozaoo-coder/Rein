//! Rein 应用入口：装配状态、注册所有模块命令。
//!
//! 新增命令的完整步骤见 docs/ARCHITECTURE.md「扩展指南」；
//! 每次在这里登记新命令时，必须同步更新前端 `src/services/*Service.ts`。

mod db;
mod error;
mod modules;
mod state;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = db::init(app.handle())?;
            app.manage(AppState::new(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // diet
            modules::diet::commands::list_foods,
            modules::diet::commands::get_food,
            modules::diet::commands::create_food,
            modules::diet::commands::search_foods_fuzzy,
            modules::diet::commands::list_meals,
            modules::diet::commands::list_meals_range,
            modules::diet::commands::log_meal,
            modules::diet::commands::delete_meal,
            modules::diet::commands::recipe_prefs_list,
            modules::diet::commands::recipe_prefs_set,
            modules::diet::commands::recipe_prefs_delete,
            // nutrition
            modules::nutrition::commands::get_daily_summary,
            modules::nutrition::commands::get_targets,
            modules::nutrition::commands::set_targets,
            modules::nutrition::commands::get_profile,
            modules::nutrition::commands::update_profile,
            modules::nutrition::commands::get_calc_state,
            modules::nutrition::commands::save_calc_state,
            modules::nutrition::commands::list_body_metrics,
            modules::nutrition::commands::record_body_metric,
            modules::nutrition::commands::delete_body_metric,
            // todo
            modules::todo::commands::list_todos,
            modules::todo::commands::list_all_todos,
            modules::todo::commands::create_todo,
            modules::todo::commands::update_todo,
            modules::todo::commands::delete_todo,
            modules::todo::commands::sync_recurrences,
            // ledger（记账：流水 + 月度预算）
            modules::ledger::commands::list_ledger_entries,
            modules::ledger::commands::create_ledger_entry,
            modules::ledger::commands::update_ledger_entry,
            modules::ledger::commands::delete_ledger_entry,
            modules::ledger::commands::get_ledger_budget,
            modules::ledger::commands::set_ledger_budget,
            // exercise
            modules::exercise::commands::list_workouts,
            modules::exercise::commands::list_all_workouts,
            modules::exercise::commands::create_workout,
            modules::exercise::commands::delete_workout,
            // pomodoro
            modules::pomodoro::commands::save_pomodoro_session,
            modules::pomodoro::commands::list_pomodoro_sessions,
            // session（训练课会话：落盘 + 中断恢复）
            modules::session::commands::session_start,
            modules::session::commands::session_snapshot,
            modules::session::commands::session_active,
            modules::session::commands::session_finish,
            modules::session::commands::session_abort,
            modules::session::commands::session_for_workout,
            modules::session::commands::strength_history,
            modules::session::commands::strength_exercises,
            modules::session::commands::strength_last_weights,
            // plan（训练课程：CRUD + 最近使用）
            modules::plan::commands::list_workout_plans,
            modules::plan::commands::get_workout_plan,
            modules::plan::commands::upsert_workout_plan,
            modules::plan::commands::delete_workout_plan,
            modules::plan::commands::touch_workout_plan,
            modules::plan::commands::plan_seed_status_cmd,
            modules::plan::commands::apply_plan_seed_migrate,
            modules::plan::commands::apply_plan_seed_override,
            modules::plan::commands::apply_plan_seed_keep,
            // program（健康方案：持久化 + 单激活 + 日程重排；计算在前端引擎）
            modules::program::commands::program_list,
            modules::program::commands::program_get_active,
            modules::program::commands::program_create,
            modules::program::commands::program_update_params,
            modules::program::commands::program_archive,
            modules::program::commands::program_delete,
            modules::program::commands::program_schedule_replace,
            modules::program::commands::program_meals_get,
            modules::program::commands::program_meals_range,
            modules::program::commands::program_meals_set,
            modules::program::commands::program_meals_clear,
            modules::program::commands::shopping_checks_list,
            modules::program::commands::shopping_check_set,
            modules::program::commands::shopping_checks_clear,
            // tracking（跑步前台保活：Android 锁屏后维持 GPS 与计时）
            modules::tracking::commands::tracking_keepalive,
            modules::tracking::commands::tracking_status,
            // ai
            modules::ai::commands::ai_parse_food_text,
            modules::ai::commands::ai_parse_target_adjust,
            modules::ai::commands::ai_model_list,
            modules::ai::commands::ai_model_add,
            modules::ai::commands::ai_model_update,
            modules::ai::commands::ai_model_delete,
            modules::ai::commands::ai_model_set_default,
            modules::ai::commands::ai_model_save_probe,
            modules::ai::commands::ai_chat_ensure,
            modules::ai::commands::ai_chat_messages,
            modules::ai::commands::ai_chat_append,
            modules::ai::commands::ai_chat_clear,
            modules::ai::commands::ai_chat_cut,
            modules::ai::commands::ai_chat_list,
            modules::ai::commands::ai_chat_rename,
            modules::ai::commands::ai_chat_search,
            // web（AI 联网：搜索/抓页，默认必应）
            modules::web::commands::web_fetch,
            modules::web::commands::web_search,
        ])
        .run(tauri::generate_context!())
        .expect("Rein 启动失败");
}
