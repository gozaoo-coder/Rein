//! 校园教务域数据模型。
//!
//! 分两类：
//! - **远端类型**（`Remote*` / `Timetable*`）—— 教务系统 JSON 的逐字段映射，只做反序列化。
//!   刻意全部加 `#[serde(default)]`：教务系统会随版本增删字段，缺字段不该让整次同步失败。
//! - **本地类型**（`Campus*`）—— 落库后的形状，同时是前后端 IPC 的契约，与 `src/types/campus.ts` 一一对应。

use serde::{Deserialize, Serialize};

// ─────────────────────────── 远端：学期 ───────────────────────────

/// 课表页面里 `var semesters = JSON.parse("...")` 的元素。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSemester {
    pub id: i64,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub name_en: Option<String>,
    #[serde(default)]
    pub school_year: Option<String>,
    /// `"2026-09-14"` —— 周次 → 公历日期的唯一锚点
    #[serde(default)]
    pub start_date: Option<String>,
    /// `"2027-01-24"`
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub week_start_on_sunday: Option<bool>,
    #[serde(default)]
    pub season: Option<String>,
}

// ─────────────────────────── 远端：课表 ───────────────────────────

/// `courseType` 只需要中文名
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNamed {
    #[serde(default)]
    pub name_zh: Option<String>,
}

/// `print-data` → `studentTableVms[0].activities[]`，一个元素 = **一门课的一个上课时段**。
///
/// 关键字段说明：
/// - `weekday` 1=周一 … 7=周日（教务口径）
/// - `week_indexes` 教学周序号（如 `[9,10,11,12]`），**不是公历周**
/// - `start_time` / `end_time` `"16:30"` / `"18:05"` —— 教务已经算好了本节次的真实时间，
///   我们不需要自己维护「第几节→几点」的表，这也是需求里「左侧列显示实际上课时间」的数据来源
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableActivity {
    #[serde(default)]
    pub lesson_id: Option<i64>,
    #[serde(default)]
    pub lesson_code: Option<String>,
    #[serde(default)]
    pub lesson_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub weeks_str: Option<String>,
    #[serde(default)]
    pub week_indexes: Vec<i64>,
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub building: Option<String>,
    #[serde(default)]
    pub campus: Option<String>,
    #[serde(default)]
    pub weekday: Option<i64>,
    #[serde(default)]
    pub start_unit: Option<i64>,
    #[serde(default)]
    pub end_unit: Option<i64>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub teachers: Vec<String>,
    #[serde(default)]
    pub course_type: Option<RemoteNamed>,
    #[serde(default)]
    pub credits: Option<f64>,
    /// 教务自带的课程配色（如 `#3B73B6`）。用它能让 App 里的课表和学生网页上看到的一致。
    #[serde(default)]
    pub bgc: Option<String>,
}

/// `studentTableVms[0]`：一次课表拉取的完整结果。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentTableVm {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    /// 学号
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub grade: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub major: Option<String>,
    #[serde(default)]
    pub adminclass: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
    #[serde(default)]
    pub activities: Vec<TimetableActivity>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableResponse {
    #[serde(default)]
    pub student_table_vms: Vec<StudentTableVm>,
}

/// 课表页面上刮下来的变量（[`super::guet::GuetAdapter::fetch_page_vars`] 的产物）。
#[derive(Debug, Clone, Default)]
pub struct PageVars {
    pub semesters: Vec<RemoteSemester>,
}

// ─────────────────────────── 本地：落库形状 ───────────────────────────

/// 账号。**`password` / `cookies` 不在这个形状里** —— 它们只活在 Rust 内部
/// （`AccountRow`），读路径统一走这里，前端只能看到 `has_password` / `logged_in` 两个布尔。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusAccount {
    pub id: i64,
    pub system_kind: String,
    pub base_url: String,
    pub login_name: String,
    /// 是否已保存密码（前端只认这个，认不到密码本身）
    pub has_password: bool,
    /// Cookie jar 里已有主票据
    pub logged_in: bool,
    pub session_at: Option<String>,
    pub student_id: Option<String>,
    pub student_code: Option<String>,
    pub student_name: Option<String>,
    pub department: Option<String>,
    pub major: Option<String>,
    pub adminclass: Option<String>,
    pub grade: Option<String>,
    pub total_credits: Option<f64>,
    pub save_password: bool,
    pub active: bool,
    pub last_sync_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusSemester {
    pub id: i64,
    pub account_id: i64,
    pub remote_id: i64,
    pub code: Option<String>,
    /// 展示名，如「2026-2027 第一学期」
    pub name: String,
    pub school_year: Option<String>,
    pub season: Option<String>,
    pub start_date: String,
    pub end_date: String,
    pub week_start_on_sunday: bool,
    pub total_weeks: i64,
    pub current_week: Option<i64>,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusCourse {
    pub id: i64,
    pub semester_id: i64,
    pub remote_lesson_id: i64,
    pub course_code: Option<String>,
    pub course_name: String,
    pub lesson_code: Option<String>,
    pub lesson_name: Option<String>,
    pub teachers: Vec<String>,
    pub credits: Option<f64>,
    pub course_type: Option<String>,
    pub color: Option<String>,
}

/// 上课时段 —— 课表渲染的基本单位（`campus_sessions` + 所属课程的展平）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusSession {
    pub id: i64,
    pub course_id: i64,
    pub weekday: i64,
    pub start_unit: i64,
    pub end_unit: i64,
    pub start_time: String,
    pub end_time: String,
    /// 教学周序号数组
    pub weeks: Vec<i64>,
    pub weeks_str: Option<String>,
    pub room: Option<String>,
    pub building: Option<String>,
    pub campus: Option<String>,
    // 展平的课程字段（避免前端二次 join）
    pub course_name: String,
    pub course_code: Option<String>,
    pub teachers: Vec<String>,
    pub credits: Option<f64>,
    pub course_type: Option<String>,
    pub color: Option<String>,
}

/// 一节课在**某个公历日期**上的一次发生。
///
/// 课表要按日/周/月浏览，而教务只给「第 N 教学周 + 星期几」，所以展开这一步放在
/// Rust（**唯一一处**做周次换算的地方，时间线物化也复用它），前端拿到的是直接的日期。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    /// `YYYY-MM-DD`
    pub date: String,
    pub week: i64,
    pub session: CampusSession,
}

/// 左侧时间轴的一行 —— 由当天实际排课的节次去重得到。
///
/// 这正是需求里「第几节那一列要改成实际上课时间」的数据来源：
/// 教务的 `startTime`/`endTime` 已经是该节次的真实时刻，不需要我们维护节次表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSlot {
    pub start_unit: i64,
    pub end_unit: i64,
    pub start_time: String,
    pub end_time: String,
    /// 距 00:00 的分钟数（与 `todos.start_min` 同口径，方便直接画时间轴）
    pub start_min: i64,
    pub duration_min: i64,
}

/// 课表视图（`campus_schedule` 返回）。一次请求把渲染需要的都带上，省掉二次往返。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub account: Option<CampusAccount>,
    pub semester: Option<CampusSemester>,
    pub entries: Vec<ScheduleEntry>,
    /// 按 `start_time` 升序去重后的节次时间表
    pub time_slots: Vec<TimeSlot>,
    /// 该学期的全部课程（用于「课程清单」与配置页统计）
    pub courses: Vec<CampusCourse>,
}

// ─────────────────────────── 选课（course-selection-api） ───────────────────────────

/// 一个选课批次（`open-turns` 的元素）。
///
/// 字段名对齐教务，且**全部带 `default`**：不同轮次的字段会缺，缺字段不该让整个批次列表失败。
/// 唯一没有类型假设的是 `id` —— 它在教务那边可能是数字、在路由参数里又是字符串，
/// 而我手上没有非空样本可验证（批次当前关闭），所以原样透传，
/// 前端当不透明标识用。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectTurn {
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub bulletin: Option<String>,
    /// 当前是否允许进入选课
    #[serde(default)]
    pub allow_enter: bool,
    /// 不允许进入的原因（逐条展示给学生）
    #[serde(default)]
    pub disallow_reasons: Vec<String>,
    #[serde(default)]
    pub open_date_time_text: Option<String>,
    #[serde(default)]
    pub select_date_time_text: Option<String>,
    #[serde(default)]
    pub drop_date_time_text: Option<String>,
    #[serde(default)]
    pub add_rules_text: Vec<String>,
    #[serde(default)]
    pub drop_rules_text: Vec<String>,
    /// 开窗/选课/退课的精确区间。**抢课的起跑线就在这里** —— 文本字段是给人看的，
    /// 区间里的 `startDateTime` 才是能拿去对时的机器可读值。
    #[serde(default)]
    pub open_date_time_range: Option<DateTimeRange>,
    #[serde(default)]
    pub select_date_time_range: Option<DateTimeRange>,
    #[serde(default)]
    pub drop_date_time_range: Option<DateTimeRange>,
}

/// 教务给的 `{startDateTime, endDateTime}`，形如 `2026-09-17 08:00:00`。
/// 命名与取值都对齐教务，不去猜别的键名。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateTimeRange {
    #[serde(default)]
    pub start_date_time: Option<String>,
    #[serde(default)]
    pub end_date_time: Option<String>,
}

impl CourseSelectTurn {
    /// 开抢时刻：优先取结构化区间的起点，退化才去 `selectDateTimeText` 里抠第一个时刻。
    ///
    /// 返回**原样文本**（教务服务器墙上时间），由 `grab` 模块按时钟偏差换算成本机时刻 ——
    /// 这里绝不能直接 `parse` 成本机时间，服务器与学生电脑经常不在一个时区/时区设置上。
    pub fn opens_at_text(&self) -> Option<String> {
        for range in [
            self.select_date_time_range.as_ref(),
            self.open_date_time_range.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(start) = range.start_date_time.as_deref().map(str::trim) {
                if !start.is_empty() {
                    return Some(start.to_string());
                }
            }
        }
        // `2026-09-17 08:00 ~ 23:59` —— 取波浪线前那一段
        let text = self.select_date_time_text.as_deref()?.trim();
        let head = text.split(['~', '至', '—']).next()?.trim();
        (!head.is_empty()).then(|| head.to_string())
    }

    /// 窗口关闭时刻。与 [`Self::opens_at_text`] 对称：先看结构化区间的终点，
    /// 退化才去 `selectDateTimeText` 里抠波浪线后面那一段。
    pub fn closes_at_text(&self) -> Option<String> {
        for range in [
            self.select_date_time_range.as_ref(),
            self.open_date_time_range.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(end) = range.end_date_time.as_deref().map(str::trim) {
                if !end.is_empty() {
                    return Some(end.to_string());
                }
            }
        }
        let text = self.select_date_time_text.as_deref()?.trim();
        let tail = text.split(['~', '至', '—']).nth(1)?.trim();
        (!tail.is_empty()).then(|| tail.to_string())
    }
}

/// `query-lesson` 的查询条件对象。
///
/// 字段来自教务处 SPA 渲染出的表单（`query-condition/{turnId}` 定义），实测出现的就这几个。
/// 全部可选且**跳过 None**：教务对多余键容忍度未知，少发比多发安全。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_name: Option<String>,
    /// 课程名或代码。**与 `lesson_name_or_code` 是两个独立字段** ——
    /// 课程（course）与教学班（lesson）在教务那边是两层概念，
    /// SPA 的搜索表单里就是两个输入框（`catchSearch.courseNameOrCode` / `.lessonNameOrCode`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_name_or_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lesson_name_or_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teacher_name_or_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub campus_id: Option<i64>,
    /// 勾选后每个教学班带回已选人数；不勾则 `stdCount` 可能缺省。
    /// 抢课要有它才能判断「满没满」，所以引擎默认带上。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_count: Option<bool>,
    /// 指定教学班 id 集合时按 id 精确查（引擎用它核对单门课是否还有余量）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_type: Option<String>,
}

/* ─────────────────────────── 自动抢课（grab） ─────────────────────────── */

/// 一条抢课任务的终态集合。非终态的任务会被引擎不断推进。
pub const GRAB_WAITING: &str = "waiting";
pub const GRAB_RUNNING: &str = "running";
pub const GRAB_SUCCESS: &str = "success";
pub const GRAB_FAILED: &str = "failed";
pub const GRAB_CONFLICT: &str = "conflict";
pub const GRAB_PAUSED: &str = "paused";
pub const GRAB_CANCELLED: &str = "cancelled";

/// 是否存在「引擎不该再碰」的终态，供 SQL 与前端共用一套判断。
pub fn grab_is_terminal(status: &str) -> bool {
    matches!(
        status,
        GRAB_SUCCESS | GRAB_FAILED | GRAB_CONFLICT | GRAB_CANCELLED
    )
}

/// 抢课任务的**过程**状态。`status` 说「结果如何」，`phase` 说「现在在干嘛」——
/// 抢课过程中用户最想知道的是后者（「已占位，正在确认」和「正在提交」是两种心情）。
pub const PHASE_IDLE: &str = "idle";
pub const PHASE_SUBMIT: &str = "submit";
pub const PHASE_POLL: &str = "poll";

/// 一条抢课任务（落库 + IPC 同一形状）。
///
/// `lesson_name` / `course_name` 是**入队时的快照**：抢课期间用户可能已经退出批次、
/// 教务可能已经把课撤下，但任务单上总得有个名字给人看。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabTask {
    pub id: i64,
    /// 列表/路径用的批次 id（`open-turns` 里那个）
    pub turn_id: String,
    /// **提交体**用的批次 id（`courseSelectTurnAssoc`）。
    ///
    /// 来自「进批次」接口返回的 `options.turn.id`，与 `turn_id` **未必相同** ——
    /// 这一点没有真机样本可验，所以两个都留着，由 [`GrabTask::turn_assoc`] 决定用哪个。
    #[serde(default)]
    pub turn_assoc: Option<String>,
    #[serde(default)]
    pub turn_name: Option<String>,
    /// 教学班 id（不透明值）
    pub lesson_id: serde_json::Value,
    #[serde(default)]
    pub lesson_name: Option<String>,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub teacher: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
    /// `predicate`（占位优先，推荐）/ `direct`（直接提交）
    pub mode: String,
    #[serde(default)]
    pub virtual_cost: Option<i64>,
    #[serde(default)]
    pub schedule_group_id: Option<serde_json::Value>,
    /// 教务墙钟时间文本（如 `2026-09-17 08:00:00`），到点由引擎换算成本机时刻开火
    #[serde(default)]
    pub window_wall: Option<String>,
    /// 窗口关闭时刻。越过它就收手 —— 依赖「教务会回一句选课已结束」来停手太脆了。
    #[serde(default)]
    pub window_end_wall: Option<String>,
    /// 入队时还不知道窗口什么时候开（比如提前一晚预设、教务还没公布批次）。
    ///
    /// 这种任务**不会盲撞** —— 撞出来的「不在选课时间」会被判成终态，
    /// 等于预设白费。引擎改为每隔一阵去问一次 `open-turns`，拿到窗口就转成精确开火。
    #[serde(default)]
    pub await_window: bool,
    /// 占位是否**已经交过**。
    ///
    /// 必须有这个显式标记，不能靠「`attempts == 0` 就说明还没占位」去推断 ——
    /// 占位落定与正式提交之间 `attempts` 还是 0，推断的结果就是每次回到提交那一步
    /// 又去占一次位，任务永远在占位和轮询之间打转，正式提交一辈子发不出去。
    #[serde(default)]
    pub predicate_done: bool,
    pub status: String,
    pub phase: String,
    /// 真正提交过几次（占位与正式提交都算）
    pub attempts: i64,
    /// 轮询了几次
    pub polls: i64,
    /// 连败次数：任何一步成功即清零，用于指数退避
    pub strikes: i64,
    /// 连败的**种类**（`full` / `retry` / …）。种类一变就重新计数 ——
    /// 「一直满员」和「一直未知错误」该有完全不同的耐心。
    #[serde(default)]
    pub strike_kind: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub last_message: Option<String>,
    /// 下一次该动它的时刻（本机 unix **毫秒**）。引擎用它做「谁最急先管谁」的排序，
    /// 用毫秒是因为开窗瞬间那几百毫秒决定了抢不抢得到。
    pub next_at: i64,
    /// **开火时刻**（本机 unix 毫秒，已按服务器偏差与提前量校正）。
    ///
    /// 只读派生值，不落库：它随时钟偏差变，而偏差是运行时量。界面的倒计时直接用它，
    /// 免得前端自己再实现一遍墙上时间换算 —— 那条换算只该有一份（`grab::fire_at_ms`）。
    #[serde(default)]
    pub fire_at: Option<i64>,
    #[serde(default)]
    pub queued_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
    /// 志愿组 id。同组是**互斥备选**（时间冲突 / 只能选一门），只会中一个：
    /// 任一中选，同组其余立刻取消。
    ///
    /// `None` / 空字符串 = 独立任务，行为与加这几列之前**完全一致**。
    #[serde(default)]
    pub group_key: Option<String>,
    /// 组名。入队那一刻抄一份，纯给人看（与课名/教师同样冗余存）。
    #[serde(default)]
    pub group_name: Option<String>,
    /// 志愿序：1 = 第一志愿，**小的优先**。0 = 不在任何组里。
    #[serde(default)]
    pub priority: i64,
    /// 连续满员的起点（本机 ms）。只在「让贤期限」> 0 时被读 —— 见 [`GrabSettings::cede_after_ms`]。
    #[serde(default)]
    pub stuck_since: Option<i64>,
    /// **派生值，不落库**：把它压在待命状态的那个更高优先级的任务 id（同 `fire_at` 的先例）。
    /// 界面据此显示「等第 N 志愿」，而不是让前端自己再算一遍互斥关系。
    #[serde(default)]
    pub held_by: Option<i64>,
}

/// 加入抢课任务单时，一门课要带的信息。
///
/// 课程名/教师/学分都由前端在**入队那一刻**从刚查回来的教学班里抄一份 ——
/// 引擎之后不再回头去教务查「这门课叫什么」，它只负责抢。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabTargetInput {
    pub lesson_id: serde_json::Value,
    #[serde(default)]
    pub lesson_name: Option<String>,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub teacher: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
    #[serde(default)]
    pub virtual_cost: Option<i64>,
    #[serde(default)]
    pub schedule_group_id: Option<serde_json::Value>,
    /// 志愿组 id / 组名 / 志愿序。三者一起给才成组；不给就是独立任务。
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub priority: i64,
}

impl GrabTask {
    /// 提交类接口该用的批次 id。
    ///
    /// 优先用「进批次」拿到的那个（SPA 就是用它）；拿不到时退回列表 id ——
    /// 那是我们唯一有把握的值，且在两者其实相等时完全正确。
    pub fn turn_assoc(&self) -> &str {
        self.turn_assoc
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.turn_id)
    }
}

/// 引擎快照（`campus_grab_state` 返回 / `campus://grab` 事件负载）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabState {
    /// 引擎线程是否活着（恒为 true；false 只在启动失败时出现）
    pub alive: bool,
    /// 是否有任务处在非终态
    pub active: bool,
    /// 教务服务器时间文本（最近一次采样）
    pub server_time: Option<String>,
    /// 服务器墙钟 − 本机墙钟（秒）。倒计时与开火时刻全按它校正。
    pub skew_sec: Option<i64>,
    /// 当前最早的下一次动作时刻（本机 unix 秒），没有任务时为 None
    pub next_at: Option<i64>,
    /// 最近一次开火时刻（本机 unix 毫秒）。界面靠它做倒计时。
    pub next_fire_at: Option<i64>,
    /// 引擎级故障（如教务会话失效）：一旦出现，所有任务都会停下等用户处理
    pub last_error: Option<String>,
    /// 窗口监听的最近结果：教务当前有哪些批次。
    ///
    /// 引擎**不再只在「有任务在等窗口」时才探测**（那会让还没排课的人完全不知道窗口开了）。
    /// 只要账号在、开关开着，就每分钟安静地问一次，把结果放这儿给界面显示。
    #[serde(default)]
    pub turns: Vec<GrabTurnBrief>,
    /// 最近一次窗口探测的时刻（本机 unix 秒）
    #[serde(default)]
    pub probed_at: Option<i64>,
    pub tasks: Vec<GrabTask>,
}

/// 批次的轻量摘要 —— 窗口监听的结果，只给界面看。
///
/// 不直接复用 `CourseSelectTurn`：那个结构体字段多、还带公告与规则正文，
/// 每秒都可能推给前端的事件流里没必要背着它们。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabTurnBrief {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// 当前是否允许进入（`allowEnter`）—— 「窗口真的开了」的判据
    #[serde(default)]
    pub allow_enter: bool,
    #[serde(default)]
    pub select_text: Option<String>,
    #[serde(default)]
    pub window_start: Option<String>,
    #[serde(default)]
    pub window_end: Option<String>,
}

/// 引擎节奏参数。默认值按「一个学生抢 1–4 门课」标定：
/// 够快（开窗瞬间就出手），又不至于把教务网关打成风控对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabSettings {
    /// 两次**提交**之间的全局最小间隔（毫秒）。这是防封的主要旋钮。
    pub min_interval_ms: i64,
    /// 轮询受理结果的间隔（毫秒）。SPA 用 2000，这里不更激进。
    pub poll_interval_ms: i64,
    /// 满员后重试的间隔（毫秒）。比普通重试慢 —— 名额释放是稀疏事件，快没意义。
    pub full_retry_ms: i64,
    /// 出错后的退避基数（毫秒），按 `strikes` 指数增长
    pub backoff_ms: i64,
    /// 退避上限（毫秒）
    pub max_backoff_ms: i64,
    /// 提前量（毫秒）：在开窗时刻**之前**多久出手，用来抵消我们的网络往返。
    pub lead_ms: i64,
    /// 单个任务的最大提交次数；0 = 不限（抢课常态）
    pub max_attempts: i64,
    /// 轮询同一受理单的最大次数，超过就当作结果不明并重投
    pub max_polls: i64,
    /// **让贤期限**（毫秒）：当前志愿连续满员超过这么久，就把出手机会让给下一志愿。
    ///
    /// **0 = 死守（默认）**：只有当前志愿进终态（冲突/超出次数/连败）或窗口关闭，
    /// 才轮到下一志愿。设成 `180000` 就是「满员 3 分钟后让贤」。
    ///
    /// 让出的那个任务**仍是非终态**：后面志愿要是也没成，它会自动回到「当前志愿」。
    #[serde(default)]
    pub cede_after_ms: i64,
    /// **窗口监听**：App 开着就每隔一阵去问一次「窗口公布了没有」，**即使任务单是空的**。
    ///
    /// 默认开。关掉它的唯一理由是「不想让这台机器每分钟碰一次教务」。
    #[serde(default = "default_true")]
    pub watch_window: bool,
}

/// `serde` 的 `default` 只认函数名，所以单独写一个（不能用 `bool::default` —— 那是 false）。
fn default_true() -> bool {
    true
}

impl Default for GrabSettings {
    fn default() -> Self {
        Self {
            min_interval_ms: 700,
            poll_interval_ms: 2000,
            full_retry_ms: 5000,
            backoff_ms: 1500,
            max_backoff_ms: 30_000,
            lead_ms: 800,
            max_attempts: 0,
            max_polls: 15,
            cede_after_ms: 0,
            watch_window: true,
        }
    }
}

impl GrabSettings {
    /// 落库前收口。
    ///
    /// **下限特意压得很低**（最小间隔 10ms ≈ 100 次/秒）：2026-09 拿真账号对教务做过压测，
    /// 80 次/秒无异常，所以「快」这件事该由用户决定，而不是被一个保守的钳位挡住。
    ///
    /// 但**默认值仍然保守**（`Default` 里是最小间隔 700ms）—— 钳位放开的只是「能调到多少」，
    /// 不是「默认就有多快」。而且压测打的是 `bkjwtest`（测试域），生产域的风控策略未必一样；
    /// 抢课的胜负手其实是**对时**（`lead_ms` 打得准）与**占位优先**，不是把请求数堆上去。
    ///
    /// 唯一还留着「不许调」的东西是那几条**语义上的边界**：退避上限不得低于基数
    /// （否则退避会越退越快）、`0` 在 `max_attempts` / `cede_after_ms` 上是「不限/死守」这些有意义的取值。
    pub fn sanitized(mut self) -> Self {
        self.min_interval_ms = self.min_interval_ms.clamp(10, 10_000);
        self.poll_interval_ms = self.poll_interval_ms.clamp(50, 30_000);
        self.full_retry_ms = self.full_retry_ms.clamp(100, 120_000);
        self.backoff_ms = self.backoff_ms.clamp(50, 60_000);
        self.max_backoff_ms = self.max_backoff_ms.clamp(self.backoff_ms, 300_000);
        self.lead_ms = self.lead_ms.clamp(0, 5_000);
        self.max_attempts = self.max_attempts.clamp(0, 100_000);
        self.max_polls = self.max_polls.clamp(1, 200);
        // 0 是「死守」这个有意义的值，别把它钳到别的数上；上限一小时
        self.cede_after_ms = self.cede_after_ms.clamp(0, 3_600_000);
        self
    }
}

/// 选课子系统的整体状态（`campus_course_select_status` 返回）。
///
/// 一次请求把「能不能用」讲清楚：令牌拿没拿到、服务器几点了、我是谁、有哪些批次。
/// 抢课对时全靠 `server_time`，不要用本机时钟 —— 学生电脑的时间经常偏。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectStatus {
    /// 令牌是否就绪（false 时后面的字段都可能是空的）
    pub ready: bool,
    /// 不可用的原因，直接给用户看
    pub reason: Option<String>,
    pub server_time: Option<String>,
    pub student_id: Option<i64>,
    pub student_code: Option<String>,
    pub student_name: Option<String>,
    /// 开放中的批次；**空数组表示当前没有选课窗口**，属正常状态
    pub turns: Vec<CourseSelectTurn>,
    /// 运行时暴露给界面的「选课页」地址（含令牌），便于用户去官方页面核对
    pub entry_url: Option<String>,
}

/// 教学班里的课程信息（`lesson.course`）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonCourse {
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub name_zh: Option<String>,
    #[serde(default)]
    pub name_en: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
}

/// 学生在这门教学班上的选课状态（`lesson.selectedLesson`，未选时为 null）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonSelection {
    /// 待筛选 | 已选中 | …
    #[serde(default)]
    pub status: Option<String>,
    /// 已在课表里钉住
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub need_attend: bool,
}

/// 一个上课小组（同一门课可能有多个可选组，`lesson.scheduleGroups`）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleGroup {
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub no: Option<i64>,
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub limit_count: Option<i64>,
    /// 上课时间地点（渲染用）
    #[serde(default)]
    pub date_time_place: serde_json::Value,
}

/// 一个教学班（`query-lesson` 的元素）。
///
/// 字段从 SPA 的表格渲染代码逆推而来，且**真机上没有非空样本**（选课批次当前未开），
/// 所以全部带 `default`：能缺就缺，缺了也别让列表整个挂掉。
/// 真正提交选课时只用得上 `id`，其余都是给人看的。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectLesson {
    /// 教学班 id —— 提交选课时的 `lessonAssoc`
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub course: Option<LessonCourse>,
    #[serde(default)]
    pub selected_lesson: Option<LessonSelection>,
    #[serde(default)]
    pub std_count: Option<i64>,
    #[serde(default)]
    pub limit_count: Option<i64>,
    #[serde(default)]
    pub teachers: Vec<serde_json::Value>,
    #[serde(default)]
    pub schedule_groups: Vec<ScheduleGroup>,
    #[serde(default)]
    pub can_select: Option<bool>,
}

/// 选课请求单元（教务叫 `requestMiddleDto`）。字段名逐字对齐 SPA 的构造代码：
/// `{ lessonAssoc, virtualCost, scheduleGroupAssoc }`，免听时追加 `needAttend`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddItem {
    /// 教学班 id
    pub lesson_assoc: serde_json::Value,
    /// 意愿值（虚拟钱包）。SPA 里该字段**总是存在**（未启用时为 null），所以这里不跳过。
    pub virtual_cost: Option<i64>,
    /// 上课小组 id；未选择时 SPA 里是 undefined，JSON 会整个丢掉该键，这里照做。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_group_assoc: Option<serde_json::Value>,
    /// 时间冲突时的免听标记
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need_attend: Option<bool>,
}

/// 选课/退课结果（`add-drop-response` / `predicate-response` 的 data）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectResult {
    #[serde(default)]
    pub success: bool,
    /// 失败原因
    #[serde(default)]
    pub error_message: Option<SelectErrorMessage>,
    /// 与已选课程时间冲突，需要办理免听
    #[serde(default)]
    pub resend: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectErrorMessage {
    #[serde(default)]
    pub text: Option<String>,
}

/// 一次选课/退课提交的受理回执。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectTicket {
    pub request_id: String,
}

/// 轮询结果（`campus_course_select_result` 返回）。
///
/// `pending = true` 表示服务端还在处理，前端应隔 2 秒再问一次（SPA 最多问 10 次）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectPoll {
    pub pending: bool,
    pub success: bool,
    pub message: Option<String>,
    /// 需要免听：前端应提示用户，确认后带 `needAttend` 重新提交
    pub need_attend: bool,
}

// ─────────────────────────── IPC：动作结果 ───────────────────────────
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub ok: bool,
    /// 服务端原样返回的提示（如「用户名或密码错误」），失败时给用户看
    pub message: Option<String>,
    /// 需要图形验证码；前端据此显示验证码输入框
    pub need_captcha: bool,
    /// `login_first` / `weak_password` —— 需要去网页端处理，本地重试无意义
    pub action_required: Option<String>,
    pub account: Option<CampusAccount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub courses: i64,
    pub sessions: i64,
    /// 写进时间线的派生日程条数
    pub todos_written: i64,
    pub semester_id: i64,
    pub semester_name: String,
    pub synced_at: String,
    /// 远端有、但本次未产生时段的活动数（如纯考试安排），用于诊断
    pub skipped_activities: i64,
}
