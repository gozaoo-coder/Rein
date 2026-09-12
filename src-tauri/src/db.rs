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

/// 0008 · 健康方案：
/// - profile 补充个性化约束（训练频率/时段/器械条件/忌口/经验），供方案引擎过滤生成
/// - workout_plans 补充课程 meta（器械要求 / 预估时长），供周计划组合与日程排布
/// - programs：程序计算的周期方案（内容快照存 params_json，AI 调整历史存 adjustments_json）
/// - todos.program_id：方案生成的日程待办来源标记，重排/清理按它事务化处理
const MIGRATION_0008: &str = r#"
ALTER TABLE profile ADD COLUMN training_days_per_week INTEGER;
ALTER TABLE profile ADD COLUMN preferred_time_slots TEXT;
ALTER TABLE profile ADD COLUMN equipment TEXT;
ALTER TABLE profile ADD COLUMN diet_restrictions TEXT;
ALTER TABLE profile ADD COLUMN experience TEXT;

ALTER TABLE workout_plans ADD COLUMN equipment TEXT;
ALTER TABLE workout_plans ADD COLUMN est_duration_min INTEGER;

CREATE TABLE programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  -- conservative | balanced | aggressive（保守 / 均衡 / 进取档）
  tier TEXT NOT NULL,
  -- active | archived；同一时刻至多一个 active（创建新方案时自动归档旧方案）
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  weeks INTEGER NOT NULL DEFAULT 4,
  -- 方案内容快照 JSON：{ params, days }，结构由前端 types/program.ts 约束
  params_json TEXT NOT NULL,
  -- AI / 手动调整历史 JSON 数组，每项含版本号与变更明细
  adjustments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE todos ADD COLUMN program_id INTEGER REFERENCES programs(id);
"#;

/// 0009 · 食谱偏好：方案引擎选菜与食谱库「喜欢/不喜欢」共用，rating 1=喜欢 -1=不喜欢。
const MIGRATION_0009: &str = r#"
CREATE TABLE recipe_prefs (
  recipe_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// 0010 · 方案每日菜单缓存：AI 按天生成的菜单落库（未生成的日期回落模板菜单）。
const MIGRATION_0010: &str = r#"
CREATE TABLE program_meals (
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meals_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (program_id, date)
);
"#;

/// 0011 · 今日画布：待办重复规则 / 实例键 / 子任务清单。
/// rec_rule 模板行持有规则；实例行 rec_key = "模板id:日期"（部分唯一索引保证物化幂等）。
const MIGRATION_0011: &str = r#"
ALTER TABLE todos ADD COLUMN rec_rule TEXT;
ALTER TABLE todos ADD COLUMN rec_key TEXT;
ALTER TABLE todos ADD COLUMN subtasks TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_rec_key ON todos(rec_key) WHERE rec_key IS NOT NULL;
"#;

/// 0012 · 采购清单勾选状态：清单本身由菜单实时聚合（不落库），这里只存「已买」标记。
/// item_key = 聚合行键（AI 行 `f:<foodId>` / 模板行 `n:<名称>[|u:<单位>]`），跨方案稳定复用。
const MIGRATION_0012: &str = r#"
CREATE TABLE shopping_checks (
  item_key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);
"#;

/// 0013 · 逐组重量记录：session_finish 事务内把最终快照的做组明细展开落行，
/// 是「动作重量变化曲线」的查询数据源（exercise_name 跨课程/跨编辑稳定）。
/// app_meta 为通用键值元数据（当前用于内置课程种子内容版本号）。
const MIGRATION_0013: &str = r#"
CREATE TABLE workout_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  plan_id TEXT,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  set_no INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'strength',
  weight_kg REAL,
  reps INTEGER,
  sec INTEGER,
  warmup INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sets_name ON workout_sets(exercise_name, workout_id);
CREATE INDEX idx_sets_workout ON workout_sets(workout_id);
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// 0014 · 待办附件/标记：文字正文内联，文件/图片/音频存 data URL（JSON 数组）。
/// 重复实例物化时不继承附件（按次记录）。
const MIGRATION_0014: &str = r#"
ALTER TABLE todos ADD COLUMN attachments TEXT;
"#;

/// 0015 · ai_models 增加图片发送分辨率上限（最长边像素）：NULL 时前端用默认值。
/// 发图/放大镜输出都按它压缩，尽量贴近各视觉模型的输入分辨率上限。
const MIGRATION_0015: &str = r#"
ALTER TABLE ai_models ADD COLUMN image_max_edge INTEGER;
"#;

/// 0016 · 语音会话纪要（modules/voice）：一段转写一条，
/// 句子与总结存 JSON 文本列（结构由前端约定，Rust 不解释）；
/// 音频为追加落盘的 wav 文件，audio_path 存应用数据目录内相对路径。
const MIGRATION_0016: &str = r#"
CREATE TABLE voice_memos (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  audio_path TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  sentences TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_voice_memos_chat ON voice_memos(chat_id);
CREATE INDEX idx_voice_memos_created ON voice_memos(created_at);
"#;

/// 0017 · 个人知识库主体（modules/kb）。
///
/// 一张库装下多种来源：日程/附件、运动、饮食体测、方案/语音/聊天，AI 生成的长记忆也是其中一类
/// （source_type='memory'，见 0018）。三个设计取舍：
///
/// 1. `kb_docs.body` 存规范化的可检索正文快照。源表仍是唯一真源——每次脏标记重放都从源表重新
///    派生 body，所以它是缓存不是副本；换来的是检索不必 join 十一张源表、read 能直接取 L2 正文。
/// 2. `kb_fts` 用 external content 指回 kb_chunks，索引里不重复存正文（正文已在 kb_chunks.text），
///    代价是增删改必须走配套的三个维护触发器，不能手工双写。
/// 3. `tokenize='trigram'` 是为中文选的：FTS5 的 unicode61 会把整段中文当成一个 token，做不了子串
///    匹配；trigram 按三字滑动窗口切，不需要分词器即可子串检索。代价是**查询词少于 3 个字符命中
///    为空**，所以检索层对短词必须回落到 LIKE。
///
/// `kb_dirty` 是源表触发器（0019）与索引线程之间的队列，主键即去重——同一实体反复变更只会留一行。
/// `vec_model` 记录当前向量是哪个模型算的，换模型后据此只重算该模型的向量。
const MIGRATION_0017: &str = r#"
CREATE TABLE kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  occurred_on TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  byte_len INTEGER NOT NULL DEFAULT 0,
  vec_model TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(source_type, source_id)
);
CREATE INDEX idx_kb_docs_src ON kb_docs(source_type, occurred_on);
CREATE INDEX idx_kb_docs_date ON kb_docs(occurred_on);

CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(doc_id, ord)
);
CREATE INDEX idx_kb_chunks_doc ON kb_chunks(doc_id);

CREATE VIRTUAL TABLE kb_fts USING fts5(
  text,
  content='kb_chunks',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO kb_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE kb_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_kb_vectors_model ON kb_vectors(model_id);

CREATE TABLE kb_dirty (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  op TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
);

CREATE TABLE kb_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  embedding_mode TEXT NOT NULL DEFAULT 'keyword',
  cloud_base_url TEXT,
  cloud_api_key TEXT,
  cloud_model TEXT,
  cloud_dim INTEGER,
  sources_enabled TEXT NOT NULL DEFAULT '{}',
  auto_memory INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO kb_settings (id, updated_at) VALUES (1, datetime('now'));
"#;

/// 0018 · 知识库里的「认知」层：AI 从对话中提炼并持续合并的长期记忆。
///
/// 记忆不是独立系统，而是 kb_docs 的一类来源（source_type='memory'），这样它天然进入同一套检索与
/// 召回。这里额外保留一张变更审计表，对齐 OpenViking 的 memory_diff 思路：每次会话结束抽取出的
/// 增/改/删都留一份快照，记忆改错了可以回溯是被哪轮对话改的。
/// `UNIQUE(mem_type, topic, content)` 让重复抽取天然幂等。
const MIGRATION_0018: &str = r#"
CREATE TABLE kb_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mem_type TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  active_count INTEGER NOT NULL DEFAULT 0,
  source_chat_id TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mem_type, topic, content)
);
CREATE INDEX idx_kb_memories_type ON kb_memories(mem_type);

CREATE TABLE kb_memory_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  at TEXT NOT NULL,
  ops_json TEXT NOT NULL
);
CREATE INDEX idx_kb_memory_diffs_at ON kb_memory_diffs(at);
"#;

/// 0019 · 源表变更捕获：让知识库「自动跟上」所有写入路径，包括未来新增的写法。
///
/// 用触发器而不是在各 command 里手写通知，是因为写入路径不止一处——program_schedule_replace 这类
/// 批量直写 todos、seed_foods 的 INSERT OR IGNORE、级联删除，走 command 层挂点必然会漏。
/// 触发器只写一行 kb_dirty（主键去重），开销极小；真正的分块与嵌入由索引线程异步消费。
///
/// foods 只在 is_custom=1 时登记：内置 2722 条种子每次启动都会 INSERT OR IGNORE，
/// 无条件登记会让首启入队整个食物库，而种子数据本就有 LCS 精确检索覆盖。
/// workout_sets 不单独成档，而是把父 workout 标脏——逐组明细是训练记录的组成部分。
const MIGRATION_0019: &str = r#"
CREATE TRIGGER kb_t_todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('todo',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('todo',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('todo',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_workouts_ai AFTER INSERT ON workouts BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_workouts_au AFTER UPDATE ON workouts BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_workouts_ad AFTER DELETE ON workouts BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_wsets_ai AFTER INSERT ON workout_sets BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.workout_id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_wsets_au AFTER UPDATE ON workout_sets BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.workout_id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_wsets_ad AFTER DELETE ON workout_sets BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(OLD.workout_id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;

CREATE TRIGGER kb_t_plans_ai AFTER INSERT ON workout_plans BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('plan',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_plans_au AFTER UPDATE ON workout_plans BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('plan',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_plans_ad AFTER DELETE ON workout_plans BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('plan',OLD.id,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_meals_ai AFTER INSERT ON meal_logs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('meal',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_meals_au AFTER UPDATE ON meal_logs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('meal',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_meals_ad AFTER DELETE ON meal_logs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('meal',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_metrics_ai AFTER INSERT ON body_metrics BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('body_metric',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_metrics_au AFTER UPDATE ON body_metrics BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('body_metric',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_metrics_ad AFTER DELETE ON body_metrics BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('body_metric',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_foods_ai AFTER INSERT ON foods WHEN NEW.is_custom = 1 BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('food',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_foods_au AFTER UPDATE ON foods WHEN NEW.is_custom = 1 BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('food',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_foods_ad AFTER DELETE ON foods WHEN OLD.is_custom = 1 BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('food',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_programs_ai AFTER INSERT ON programs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_programs_au AFTER UPDATE ON programs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_programs_ad AFTER DELETE ON programs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_pmeals_ai AFTER INSERT ON program_meals BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program_meal',CAST(NEW.program_id AS TEXT)||':'||NEW.date,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_pmeals_au AFTER UPDATE ON program_meals BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program_meal',CAST(NEW.program_id AS TEXT)||':'||NEW.date,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_pmeals_ad AFTER DELETE ON program_meals BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program_meal',CAST(OLD.program_id AS TEXT)||':'||OLD.date,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_memos_ai AFTER INSERT ON voice_memos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('voice_memo',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_memos_au AFTER UPDATE ON voice_memos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('voice_memo',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_memos_ad AFTER DELETE ON voice_memos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('voice_memo',OLD.id,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_msgs_ai AFTER INSERT ON ai_chat_messages BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('chat_message',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_msgs_au AFTER UPDATE ON ai_chat_messages BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('chat_message',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_msgs_ad AFTER DELETE ON ai_chat_messages BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('chat_message',OLD.id,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;
"#;

/// 0020 · 虚拟文件系统（docs/kb-vfs.md）：给每篇文档一个稳定路径，并区分「可写/只读」。
///
/// 两条新增能力各需要一个存储位：
/// 1. `kb_docs.path` 把 11 类派生文档挂进同一棵路径树（`日程/…`、`对话/{chatId}/…`），
///    glob 检索与「按目录浏览」都建立在它上面。路径是**派生的**：源数据变了路径可能变，
///    文档身份始终是 (source_type, source_id)，所以改名/改标题不会丢编目。
/// 2. `kb_files` 是知识库里唯一的「真实文件」表——用户笔记与系统规范文件的正文真源。
///    它经 source_type='note' 派生进 kb_docs（body 是缓存），编辑走 kb_files 再标脏，
///    这样「kb_docs 一律是派生缓存」这条不变量对全库成立，重放永远能重建一切。
///
/// `editable` / `system` / `kind` 做成列而不是查询时推导：UI 与 AI 工具单次读取就能拿到，
/// 不必在每个调用点重复「哪些来源可写」的规则。
const MIGRATION_0020: &str = r#"
ALTER TABLE kb_docs ADD COLUMN path TEXT;
ALTER TABLE kb_docs ADD COLUMN editable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
CREATE INDEX idx_kb_docs_path ON kb_docs(path);

CREATE TABLE kb_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

const MIGRATIONS: &[&str] = &[
    MIGRATION_0001,
    MIGRATION_0002,
    MIGRATION_0003,
    MIGRATION_0004,
    MIGRATION_0005,
    MIGRATION_0006,
    MIGRATION_0007,
    MIGRATION_0008,
    MIGRATION_0009,
    MIGRATION_0010,
    MIGRATION_0011,
    MIGRATION_0012,
    MIGRATION_0013,
    MIGRATION_0014,
    MIGRATION_0015,
    MIGRATION_0016,
    MIGRATION_0017,
    MIGRATION_0018,
    MIGRATION_0019,
    MIGRATION_0020,
];

/// 测试用：对给定连接跑完整迁移（含知识库的 FTS 表与全部触发器）。
/// 生产路径是 `init()`，它会额外做种子导入；测试不需要种子。
#[cfg(test)]
pub fn migrate_for_test(conn: &Connection) -> Result<()> {
    migrate(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只应用到 0016，模拟知识库上线之前的老库。
    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations(
               version INTEGER PRIMARY KEY,
               applied_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .unwrap();
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let v = (i + 1) as i64;
            if v > 16 {
                break;
            }
            conn.execute_batch(&format!(
                "BEGIN; {sql}; INSERT INTO schema_migrations(version) VALUES ({v}); COMMIT;"
            ))
            .unwrap();
        }
        conn
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    #[test]
    fn upgrade_from_0016_adds_knowledge_base() {
        let conn = legacy_db();
        assert!(!table_exists(&conn, "kb_docs"), "前置条件：老库还没有知识库表");

        migrate_for_test(&conn).unwrap();

        for t in [
            "kb_docs",
            "kb_chunks",
            "kb_fts",
            "kb_vectors",
            "kb_dirty",
            "kb_settings",
            "kb_memories",
            "kb_memory_diffs",
        ] {
            assert!(table_exists(&conn, t), "升级后应存在 {t}");
        }
        let ver: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ver, MIGRATIONS.len() as i64);
    }

    /// 触发器是升级后新建的，只对**之后**的写入生效。这条验证它们确实生效了——
    /// 老数据的补齐靠 scan_all 对账，但新写入必须立刻被登记。
    #[test]
    fn triggers_are_live_after_upgrade() {
        let conn = legacy_db();
        // 升级前就存在的待办：不该有脏标记（触发器还不存在）
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at)
             VALUES('老数据','general',0,'todo','x')",
            [],
        )
        .unwrap();

        migrate_for_test(&conn).unwrap();
        let dirty: i64 = conn
            .query_row("SELECT COUNT(*) FROM kb_dirty", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dirty, 0, "升级前的老数据不会被触发器追溯登记");

        // 升级后的新写入必须被登记
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at)
             VALUES('新数据','general',0,'todo','x')",
            [],
        )
        .unwrap();
        let dirty: i64 = conn
            .query_row("SELECT COUNT(*) FROM kb_dirty", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dirty, 1, "升级后的写入必须被登记");
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        // 再跑一次不该重复应用，也不该因表/触发器已存在而报错
        migrate_for_test(&conn).unwrap();
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(after, MIGRATIONS.len() as i64);
    }

    /// 触发器不能破坏既有写入路径：插一条待办仍然成功，且只多出一行脏标记。
    #[test]
    fn triggers_do_not_break_existing_writes() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        conn.execute(
            "INSERT INTO todos(title, notes, category, priority, status, created_at, date, subtasks, attachments)
             VALUES('测试','备注','general',1,'todo','x','2026-09-10','[]','[]')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        assert!(id > 0);
        conn.execute("UPDATE todos SET notes = '改过' WHERE id = ?1", [id])
            .unwrap();
        conn.execute("DELETE FROM todos WHERE id = ?1", [id]).unwrap();
        // 插入+更新+删除都作用于同一主键，脏队列里只应留最后一条 delete
        let (op, n): (String, i64) = conn
            .query_row(
                "SELECT op, (SELECT COUNT(*) FROM kb_dirty) FROM kb_dirty LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((op.as_str(), n), ("delete", 1));
    }

    /// kb_settings 是单行表，迁移里已经种了 id=1，否则后续 SQL 全部落空。
    #[test]
    fn kb_settings_has_the_singleton_row() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        let mode: String = conn
            .query_row("SELECT embedding_mode FROM kb_settings WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(mode, "keyword", "默认应为零依赖的关键词模式");
    }
}

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
