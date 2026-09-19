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
            app.manage(crate::state::VoiceHub::new());
            app.manage(crate::state::CampusHub::new());
            // 在线更新：下载/安装的进程内状态。它不落库（设置走 app_meta），
            // 但必须 manage 进来 —— 下载线程要用它广播进度、缓存已验签的候选。
            app.manage(modules::update::UpdateHub::new());

            // 知识库：状态 + 后台索引线程。
            // 索引线程要读写与应用同一份数据库，所以先完成 db::init（其中的迁移已建好 kb_* 表）
            // 并把状态 manage 进去，再启动线程。
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
            let hub = std::sync::Arc::new(modules::kb::worker::KbHub::new(data_dir));
            hub.start(app.handle().clone());
            app.manage(hub);

            // 抢课：任务单落 SQLite，后台线程按服务器时钟开火。
            // 与知识库同形 —— 先 manage 好状态（其中已含任务表）再启动线程，
            // 而且它必须在 db::init 之后，因为要读写同一份数据库。
            let grab = std::sync::Arc::new(modules::campus::grab::GrabHub::new());
            grab.start(app.handle().clone());
            app.manage(grab);
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
            modules::todo::commands::query_todos,
            modules::todo::commands::todo_distribution,
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
            modules::session::commands::strength_recent_sets,
            // sports/plans/records 见上；这份清单必须与 modules/*/commands.rs 和
            // 前端 src/services/*Service.ts 三处同步（见 docs/ARCHITECTURE.md §3）。
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
            // exercise_lib（动作库：全部运动动作的唯一真源，0025）
            modules::exercise_lib::commands::list_exercises,
            modules::exercise_lib::commands::get_exercise,
            modules::exercise_lib::commands::upsert_exercise,
            modules::exercise_lib::commands::delete_exercise,
            modules::exercise_lib::commands::restore_exercise,
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
            // ai · 在线服务（服务端下发模型 + 服务密钥 + 成本对账）
            modules::ai::online::online_service_settings_get,
            modules::ai::online::online_service_settings_save,
            modules::ai::online::online_service_catalog,
            modules::ai::online::online_service_usage,
            modules::ai::online::online_service_sync,
            modules::ai::commands::ai_usage_record,
            modules::ai::commands::ai_usage_summary,
            modules::ai::commands::ai_usage_clear,
            // web（AI 联网：搜索/抓页，默认必应）
            modules::web::commands::web_fetch,
            modules::web::commands::web_search,
            // share（分享收件箱：Android 系统分享/打开的文件）
            modules::share::commands::share_poll,
            modules::share::commands::share_read,
            // voice（语音对话：豆包 ASR/TTS + 纪要）
            modules::voice::commands::voice_config_get,
            modules::voice::commands::voice_config_save,
            modules::voice::commands::voice_config_status,
            modules::voice::commands::voice_tts_probe,
            modules::voice::commands::voice_asr_probe,
            modules::voice::commands::voice_tts_credential_save,
            modules::voice::commands::voice_asr_start,
            modules::voice::commands::voice_asr_audio,
            modules::voice::commands::voice_asr_finish,
            modules::voice::commands::voice_asr_cancel,
            modules::voice::commands::voice_tts_speak,
            modules::voice::commands::voice_memo_create,
            modules::voice::commands::voice_memo_get,
            modules::voice::commands::voice_memo_list,
            modules::voice::commands::voice_memo_set_summary,
            modules::voice::commands::voice_memo_rename,
            modules::voice::commands::voice_memo_delete,
            modules::voice::commands::voice_draft_save,
            modules::voice::commands::voice_draft_get,
            modules::voice::commands::voice_draft_clear,
            // kb（知识库与认知层：混合检索 + 长期记忆）
            modules::kb::commands::kb_status,
            modules::kb::commands::kb_search,
            modules::kb::commands::kb_read,
            modules::kb::commands::kb_reindex,
            modules::kb::commands::kb_settings_get,
            modules::kb::commands::kb_settings_set,
            modules::kb::commands::kb_probe_embedder,
            modules::kb::commands::kb_rebuild_vectors,
            modules::kb::commands::kb_memories,
            modules::kb::commands::kb_memory_apply,
            modules::kb::commands::kb_memory_delete,
            modules::kb::commands::kb_memory_archive,
            modules::kb::commands::kb_memory_restore,
            modules::kb::commands::kb_memory_maintain,
            modules::kb::commands::kb_memory_stats,
            modules::kb::commands::kb_memory_consolidated,
            modules::kb::commands::kb_cognition,
            modules::kb::commands::kb_memory_bump,
            modules::kb::commands::kb_glob,
            modules::kb::commands::kb_file_write,
            modules::kb::commands::kb_file_rename,
            modules::kb::commands::kb_file_delete,
            modules::kb::commands::kb_file_get,
            // kb（AI 虚拟工作区 v2：模态层 + 目录治理 + 全量注入，见 docs/ai-workspace.md）
            modules::kb::commands::kb_media_write,
            modules::kb::commands::kb_media_get,
            modules::kb::commands::kb_fs_move,
            modules::kb::commands::kb_fs_mkdir,
            modules::kb::commands::kb_fs_pin,
            modules::kb::commands::kb_fs_moves,
            modules::kb::commands::kb_fs_undo,
            modules::kb::commands::kb_injection_get,
            // campus（校园教务：学校系统选择器 + 课表同步 + 培养方案）
            modules::campus::commands::campus_systems,
            modules::campus::commands::campus_account_get,
            modules::campus::commands::campus_captcha,
            modules::campus::commands::campus_login,
            modules::campus::commands::campus_session_probe,
            modules::campus::commands::campus_logout,
            modules::campus::commands::campus_account_delete,
            modules::campus::commands::campus_semesters,
            modules::campus::commands::campus_set_current_semester,
            modules::campus::commands::campus_sync,
            modules::campus::commands::campus_schedule,
            modules::campus::commands::campus_program,
            // campus（选课：令牌走 EAMS 会话换取的 SSO JWT）
            modules::campus::commands::campus_course_select_status,
            modules::campus::commands::campus_course_select_lessons,
            modules::campus::commands::campus_course_select_simplest_lessons,
            modules::campus::commands::campus_course_select_query_condition,
            modules::campus::commands::campus_course_select_apply,
            modules::campus::commands::campus_course_select_predicate,
            modules::campus::commands::campus_course_select_result,
            modules::campus::commands::campus_course_select_predicate_result,
            modules::campus::commands::campus_course_select_drop,
            // campus（自动抢课：任务单 + 后台引擎）
            modules::campus::commands::campus_grab_state,
            modules::campus::commands::campus_grab_enqueue,
            modules::campus::commands::campus_grab_task_action,
            modules::campus::commands::campus_grab_clear_finished,
            modules::campus::commands::campus_grab_pause_all,
            modules::campus::commands::campus_grab_resume_all,
            modules::campus::commands::campus_grab_settings_get,
            modules::campus::commands::campus_grab_settings_set,
            // update（在线更新：多源清单 + 清单/安装包双验签 + 断点续传 + 平台安装）
            modules::update::commands::update_status,
            modules::update::commands::update_settings_set,
            modules::update::commands::update_check,
            modules::update::commands::update_download,
            modules::update::commands::update_cancel,
            modules::update::commands::update_discard,
            modules::update::commands::update_install,
            modules::update::commands::update_progress,
            modules::update::commands::update_prune_cache,
            // online（Rein 在线服务：更新分发之外的在线能力探测；模型网关为预留接口）
            modules::update::online::online_service_status,
        ])
        .run(tauri::generate_context!())
        .expect("Rein 启动失败");
}
