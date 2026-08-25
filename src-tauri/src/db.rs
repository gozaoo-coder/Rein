//! 数据库初始化与迁移。
//!
//! 迁移规则：`MIGRATIONS` 数组按下标即版本号（0001 起），只追加、永不修改历史条目；
//! 新迁移 = 在数组末尾追加一条 SQL。应用启动时在事务内补齐缺失版本。

use rusqlite::Connection;
use tauri::Manager;

use crate::error::{ReinError, Result};

/// 打开（必要时创建）应用数据目录下的 SQLite 库，并完成迁移与种子。
pub fn init(app: &tauri::AppHandle) -> Result<Connection> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ReinError::Message(format!("无法定位应用数据目录：{e}")))?;
    std::fs::create_dir_all(&dir)?;

    let conn = Connection::open(dir.join("rein.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    migrate(&conn)?;
    crate::modules::seed::seed_foods(&conn)?;
    crate::modules::seed::seed_builtin_plans(&conn)?;
    Ok(conn)
}

/// 0001 · 初始表结构：食物库 / 记录 / 资料 / 待办 / 运动 / 番茄钟
const MIGRATION_0001: &str = r#"
CREATE TABLE foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  kcal REAL NOT NULL DEFAULT 0,
  protein REAL NOT NULL DEFAULT 0,
  carb REAL NOT NULL DEFAULT 0,
  fat REAL NOT NULL DEFAULT 0,
  fiber REAL NOT NULL DEFAULT 0,
  sugar REAL NOT NULL DEFAULT 0,
  sodium_mg REAL NOT NULL DEFAULT 0,
  potassium_mg REAL NOT NULL DEFAULT 0,
  calcium_mg REAL NOT NULL DEFAULT 0,
  iron_mg REAL NOT NULL DEFAULT 0,
  zinc_mg REAL NOT NULL DEFAULT 0,
  magnesium_mg REAL NOT NULL DEFAULT 0,
  vit_a_ug REAL NOT NULL DEFAULT 0,
  vit_c_mg REAL NOT NULL DEFAULT 0,
  vit_d_ug REAL NOT NULL DEFAULT 0,
  vit_e_mg REAL NOT NULL DEFAULT 0,
  vit_b12_ug REAL NOT NULL DEFAULT 0,
  folate_ug REAL NOT NULL DEFAULT 0,
  default_unit TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE food_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  grams REAL NOT NULL,
  UNIQUE(food_id, name)
);

CREATE TABLE meal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL REFERENCES foods(id),
  date TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  quantity_mode TEXT NOT NULL,
  -- 不变量：grams 恒为换算后的克重；units/unit_name 仅用于展示
  grams REAL NOT NULL,
  units REAL,
  unit_name TEXT,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_meal_logs_date ON meal_logs(date);

CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nickname TEXT NOT NULL DEFAULT 'Rein 用户',
  sex TEXT,
  birthday TEXT,
  height_cm REAL,
  weight_kg REAL,
  target_weight_kg REAL,
  activity_level TEXT NOT NULL DEFAULT 'light',
  goal TEXT NOT NULL DEFAULT 'keep',
  target_kcal REAL NOT NULL DEFAULT 2000,
  target_protein REAL NOT NULL DEFAULT 80,
  target_carb REAL NOT NULL DEFAULT 250,
  target_fat REAL NOT NULL DEFAULT 65,
  target_sodium_mg REAL NOT NULL DEFAULT 1500,
  target_water_ml REAL NOT NULL DEFAULT 1700
);
INSERT INTO profile (id) VALUES (1);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  date TEXT,
  start_min INTEGER,
  duration_min INTEGER,
  category TEXT NOT NULL DEFAULT 'general',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo',
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_todos_date ON todos(date);

CREATE TABLE workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER,
  duration_min REAL NOT NULL,
  kcal REAL NOT NULL,
  intensity TEXT NOT NULL DEFAULT 'moderate',
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workouts_date ON workouts(date);

CREATE TABLE pomodoro_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  focus_min REAL NOT NULL,
  break_min REAL NOT NULL,
  completed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_pomodoro_started ON pomodoro_sessions(started_at);
"#;

/// 0002 · 训练课会话表：支持全程快照落盘与异常中断恢复
const MIGRATION_0002: &str = r#"
CREATE TABLE workout_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  -- active | finished | aborted；只有用户经「结束键 + 二级确认」才会离开 active
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ex_index INTEGER NOT NULL DEFAULT 0,
  set_index INTEGER NOT NULL DEFAULT 1,
  weight_kg REAL NOT NULL DEFAULT 0,
  elapsed_sec REAL NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_sessions_status ON workout_sessions(status);
"#;

/// 0003 · 训练课程表：用户可编辑课程 + 最近使用时间（种子来自 resources/workout_plans.json）
const MIGRATION_0003: &str = r#"
CREATE TABLE workout_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  workout_type TEXT NOT NULL DEFAULT 'strength',
  -- 动作数组 JSON，结构由前端 PlanExercise 约束
  exercises_json TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// 0004 · 记账：流水表 + 单行设置表（月度总预算；金额一律存整数分）
const MIGRATION_0004: &str = r#"
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- expense | income
  kind TEXT NOT NULL DEFAULT 'expense',
  -- 分类 key（前端 src/config/ledger.ts）
  category TEXT NOT NULL,
  -- 金额（分），恒为正；正负号由 kind 表达
  amount_cents INTEGER NOT NULL,
  note TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_entries_date ON ledger_entries(date);

CREATE TABLE ledger_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- 0 = 未设置月度总预算
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO ledger_settings (id) VALUES (1);
"#;

/// 0005 · 方案计算器参数快照 + 体重身高追踪。
/// calc_params 单行快照：保存计算器上次使用的身体参数（含手输年龄），未保存过时各列为 NULL；
/// body_metrics 按天一条，同日补录时 COALESCE 合并（只更新提供的项）。
const MIGRATION_0005: &str = r#"
CREATE TABLE calc_params (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sex TEXT,
  age INTEGER,
  height_cm REAL,
  weight_kg REAL,
  activity_level TEXT NOT NULL DEFAULT 'light',
  goal TEXT NOT NULL DEFAULT 'keep',
  saved_at TEXT
);
INSERT INTO calc_params (id) VALUES (1);

CREATE TABLE body_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  weight_kg REAL,
  height_cm REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_body_metrics_date ON body_metrics(date);
"#;

/// 0006 · AI：用户添加的模型配置（含探测结果）+ 聊天会话与消息历史。
/// ai_models 仅作配置存储，真正的模型请求在前端 WebView 内由 pi-ai 直连 provider；
/// 探测结果（视觉/思考/努力档）由前端写入后展示在管理页。
const MIGRATION_0006: &str = r#"
CREATE TABLE ai_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- UI 预设标识（deepseek | openai-compatible），请求参数格式按 base_url 自动探测
  provider TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  -- 能力探测：NULL=未知 1=支持 0=不支持
  vision INTEGER,
  thinking INTEGER,
  effort INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ai_models_one_default ON ai_models(is_default) WHERE is_default = 1;

CREATE TABLE ai_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'AI 对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  image_base64 TEXT,
  mime TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(chat_id, seq)
);
CREATE INDEX idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, seq);
"#;

/// 0007 · 训练记录关联来源会话：详情抽屉按此反查最后一帧快照（轨迹 / 做组明细）。
/// 手动添加的记录为 NULL；历史数据一律 NULL，抽屉回退到概要视图。
const MIGRATION_0007: &str = r#"
ALTER TABLE workouts ADD COLUMN session_id INTEGER REFERENCES workout_sessions(id);
"#;

const MIGRATIONS: &[&str] = &[
    MIGRATION_0001,
    MIGRATION_0002,
    MIGRATION_0003,
    MIGRATION_0004,
    MIGRATION_0005,
    MIGRATION_0006,
    MIGRATION_0007,
];

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations(
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = (i + 1) as i64;
        if version <= current {
            continue;
        }
        conn.execute_batch(&format!(
            "BEGIN; {sql}; INSERT INTO schema_migrations(version) VALUES ({version}); COMMIT;"
        ))?;
    }
    Ok(())
}
