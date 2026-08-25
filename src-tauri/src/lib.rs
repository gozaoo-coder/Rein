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
            modules::diet::commands::log_meal,
            modules::diet::commands::delete_meal,
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
            // plan（训练课程：CRUD + 最近使用）
            modules::plan::commands::list_workout_plans,
            modules::plan::commands::get_workout_plan,
            modules::plan::commands::upsert_workout_plan,
            modules::plan::commands::delete_workout_plan,
            modules::plan::commands::touch_workout_plan,
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
