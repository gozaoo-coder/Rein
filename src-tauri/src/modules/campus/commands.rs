//! 校园教务域命令 · 命令名与前端 `campusService.ts` 对应。
//!
//! **一条铁律：慢网络与 DB 锁不许同时持有。**
//! `AppState.db` 是一把全局 `Mutex<Connection>`，所有域共用；而教务系统是慢站点，
//! 单个大响应实测可达数十秒。若把抓取和写库塞进同一个临界区，整个 App 的命令都会被卡住。
//! 所以每个联网命令都是「短锁读 → 无锁联网 → 短锁写」三段式，
//! 与 `modules/kb` 的「embeddings 绝不持锁」是同一条规矩。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{Duration, Local, NaiveDate, Utc};
use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::error::{ReinError, Result};
use crate::state::{AppState, CampusHub, CourseSelectToken, PendingLogin};

use super::course_select::CourseSelectClient;
use super::grab::{self, GrabHub};
use super::guet::{self, GuetAdapter, TimetableSnapshot};
use super::http::{CookieJar, HttpResponse, Session};
use super::matcher;
use super::models::*;
use super::provider::{self, SchoolSystemInfo, SchoolSystemSpec};
use super::rescue;

const ACCOUNT_COLS: &str = "id, system_kind, base_url, login_name, password, cookies, session_at, \
     student_id, student_code, student_name, department, major, adminclass, grade, total_credits, \
     save_password, active, last_sync_at, created_at, updated_at";

/// 时间线物化窗口。刻意不做整学期：一门课带 `weekIndexes` 展开后一学期轻松上百条，
/// 会明显拖重 `list_all_todos` 与知识库索引。过去一周（留回看余地）+ 未来五周，
/// 足够覆盖日/周/月三种视图的实际浏览范围；超出部分在课表页照常可见——
/// 课表读的是 `campus_sessions`，不依赖派生行。
const MATERIALIZE_BACK_DAYS: i64 = 7;
const MATERIALIZE_FORWARD_DAYS: i64 = 35;

/// 课表派生行在时间线上的分类，对应前端 `CATEGORY_META['class']`
const COURSE_CATEGORY: &str = "class";

/// 派生行的时长兜底：教务偶尔缺 `endTime`，给一个常见两节课的长度，
/// 免得时间轴上出现零高块。
const DEFAULT_CLASS_MIN: i64 = 95;

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/* ─────────────────────────── 账号读写 ─────────────────────────── */

/// Rust 内部的账号形状（**含明文密码与 Cookie**）。只在本模块内流转，绝不 Serialize。
struct AccountRow {
    id: i64,
    system_kind: String,
    base_url: String,
    login_name: String,
    password: Option<String>,
    cookies: Option<String>,
    session_at: Option<String>,
    student_id: Option<String>,
    student_code: Option<String>,
    student_name: Option<String>,
    department: Option<String>,
    major: Option<String>,
    adminclass: Option<String>,
    grade: Option<String>,
    total_credits: Option<f64>,
    save_password: bool,
    active: bool,
    last_sync_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AccountRow {
    fn spec(&self) -> Result<&'static SchoolSystemSpec> {
        provider::spec(&self.system_kind)
            .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{}", self.system_kind)))
    }

    fn session(&self) -> Session {
        Session::new(&self.base_url, CookieJar::from_json(self.cookies.as_deref()))
    }

    fn saved_password(&self) -> Option<&str> {
        self.password.as_deref().filter(|p| !p.is_empty())
    }
}

fn account_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: r.get(0)?,
        system_kind: r.get(1)?,
        base_url: r.get(2)?,
        login_name: r.get(3)?,
        password: r.get(4)?,
        cookies: r.get(5)?,
        session_at: r.get(6)?,
        student_id: r.get(7)?,
        student_code: r.get(8)?,
        student_name: r.get(9)?,
        department: r.get(10)?,
        major: r.get(11)?,
        adminclass: r.get(12)?,
        grade: r.get(13)?,
        total_credits: r.get(14)?,
        save_password: r.get::<_, i64>(15)? != 0,
        active: r.get::<_, i64>(16)? != 0,
        last_sync_at: r.get(17)?,
        created_at: r.get(18)?,
        updated_at: r.get(19)?,
    })
}

/// 对外投影：丢掉密码与 Cookie，只留两个布尔。
fn to_account(a: AccountRow) -> CampusAccount {
    // 两个派生布尔必须在搬字段之前算完：结构体字面量按书写顺序求值，
    // 一旦先移走了 a 的某个字段，再对 a 调用方法就会撞上「部分移动后仍被借用」。
    let has_password = a.saved_password().is_some();
    let logged_in = CookieJar::from_json(a.cookies.as_deref()).has_session_ticket();
    CampusAccount {
        id: a.id,
        system_kind: a.system_kind,
        base_url: a.base_url,
        login_name: a.login_name,
        has_password,
        logged_in,
        session_at: a.session_at,
        student_id: a.student_id,
        student_code: a.student_code,
        student_name: a.student_name,
        department: a.department,
        major: a.major,
        adminclass: a.adminclass,
        grade: a.grade,
        total_credits: a.total_credits,
        save_password: a.save_password,
        active: a.active,
        last_sync_at: a.last_sync_at,
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

fn load_active_account(conn: &Connection) -> Result<Option<AccountRow>> {
    let sql = format!(
        "SELECT {ACCOUNT_COLS} FROM campus_accounts WHERE active = 1 ORDER BY updated_at DESC LIMIT 1"
    );
    match conn.query_row(&sql, [], account_row) {
        Ok(a) => Ok(Some(a)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 需要账号的联网命令统一从这里起步；没登录时给出可操作的中文提示。
fn require_account(conn: &Connection) -> Result<AccountRow> {
    load_active_account(conn)?
        .ok_or_else(|| ReinError::Message("还没有绑定教务系统账号，请先在「课表配置」里登录".into()))
}

/* ─────────────────────────── 会话自愈 ───────────────────────────
 *
 * 教务会话的寿命不归我们管：可能是服务端 TTL 到了，也可能是用户在别处登了一次。
 * 表现永远只有一种 —— **302 回登录页**，HTTP 层把它翻成了固定文案
 * （`guet.rs::ok_resp` / `course_select.rs::acquire`）。
 *
 * 自愈要做三件事，且必须**三件一起做**：
 *   1. 用存下的密码静默重登，拿到新 Cookie；
 *   2. **立刻落库** —— 不能等整个流程跑完。否则后半程一失败，新会话就白换了，
 *      用户下次看到的还是「请重新登录」，只能手动再同步一次（这正是这组函数存在的理由）；
 *   3. 作废选课令牌缓存 —— 那张 SSO JWT 是拿旧会话换的，会话一换它就跟着失效。
 */

/// 错误是不是「会话失效」。文案由 `guet.rs` / `course_select.rs` 统一产出，
/// 这里只认关键词 —— 与 `grab::verdict_of` 是同一套判据，两边必须一致。
pub(crate) fn is_session_lost(err: &ReinError) -> bool {
    let msg = err.to_string();
    msg.contains("会话已过期") || msg.contains("重新登录") || msg.contains("登录已过期")
}

/// 用账号里存下的密码静默重登（无验证码），返回**新会话**的 Cookie。
///
/// 从一个空 jar 起步：旧 jar 里那套已死的票据没有任何价值，留着只会在握手时
/// 先发一次死 Cookie。树维的登录流程本身要先 GET salt 把新会话建起来，空 jar 是安全的。
fn relogin(account: &AccountRow) -> Result<CookieJar> {
    let Some(password) = account.saved_password() else {
        return Err(ReinError::Message(
            "登录状态已过期，且该账号没有保存密码 —— 请到「课表配置」重新登录一次，\
             勾上「保存密码」以后过期就能自动恢复"
                .into(),
        ));
    };
    let spec = account.spec()?;
    let mut session = Session::new(&account.base_url, CookieJar::default());
    let outcome = {
        let mut adapter = GuetAdapter::new(spec, &mut session);
        adapter.login(&account.login_name, password, "")?
    };
    if !outcome.ok {
        let why = outcome
            .message
            .unwrap_or_else(|| "教务系统拒绝了这次登录".into());
        return Err(ReinError::Message(format!(
            "登录状态已过期，自动重新登录失败：{why}"
        )));
    }
    Ok(session.jar().clone())
}

/// 把刷新后的会话立刻写回账号（`session_at` 一并更新，配置页据此显示会话确认时间）。
fn persist_session(conn: &Connection, account_id: i64, jar: &CookieJar) -> Result<()> {
    conn.execute(
        "UPDATE campus_accounts SET cookies = ?1, session_at = ?2, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![jar.to_json(), now_iso(), account_id],
    )?;
    Ok(())
}

/// 会话换过了，拿旧会话换来的选课 SSO 令牌也就没用了。
fn forget_select_token(hub: &CampusHub) {
    *hub.select_token.lock().unwrap() = None;
}

/// 自愈的完整动作：静默重登（网络，**不持锁**）→ 落库 → 作废选课令牌。
///
/// 重登是两三次往返的慢网络，绝不能和 DB 锁叠在一起（见文件头那条铁律）；
/// 这个签名收 `&Mutex<Connection>` 而不是 `&Connection`，就是为了它自己决定锁的边界。
fn recover_session(db: &Mutex<Connection>, hub: &CampusHub, account: &AccountRow) -> Result<()> {
    let jar = relogin(account)?;
    {
        let conn = db.lock().unwrap();
        persist_session(&conn, account.id, &jar)?;
    }
    forget_select_token(hub);
    Ok(())
}

/* ─────────────────────────── 周次 → 公历日期 ─────────────────────────── */

/// 学期第一教学周第一天的公历日期。
/// `start_date` 理论上就是它，但仍做一次吸附：万一教务给了个周中日期，吸附后依然自洽。
fn semester_anchor(sem: &CampusSemester) -> Option<NaiveDate> {
    Some(guet::week_anchor(
        guet::parse_ymd(&sem.start_date)?,
        sem.week_start_on_sunday,
    ))
}

/// 「第 week 教学周的星期 weekday」→ 公历日期。weekday 用教务口径：1=周一 … 7=周日。
///
/// `week_start_on_sunday` 决定偏移：周一制下 周一→+0、周日→+6；周日制下 周日→+0、周一→+1。
/// 教务只给周序号，这一步是整套课表能落到日历上的唯一依据。
fn occurrence_date(
    anchor: NaiveDate,
    week: i64,
    weekday: i64,
    week_start_on_sunday: bool,
) -> Option<NaiveDate> {
    if week < 1 || !(1..=7).contains(&weekday) {
        return None;
    }
    let offset = if week_start_on_sunday {
        weekday % 7
    } else {
        weekday - 1
    };
    anchor.checked_add_signed(Duration::days((week - 1) * 7 + offset))
}

/* ─────────────────────────── 课表读取 ─────────────────────────── */

const SESSION_SELECT: &str = "SELECT s.id, s.course_id, s.weekday, s.start_unit, s.end_unit, \
     s.start_time, s.end_time, s.weeks, s.weeks_str, s.room, s.building, s.campus, \
     c.course_name, c.course_code, c.credits, c.teachers, c.course_type, c.color \
     FROM campus_sessions s JOIN campus_courses c ON c.id = s.course_id";

fn session_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CampusSession> {
    let weeks_raw: String = r.get(7)?;
    let teachers_raw: Option<String> = r.get(15)?;
    Ok(CampusSession {
        id: r.get(0)?,
        course_id: r.get(1)?,
        weekday: r.get(2)?,
        start_unit: r.get(3)?,
        end_unit: r.get(4)?,
        start_time: r.get(5)?,
        end_time: r.get(6)?,
        weeks: serde_json::from_str(&weeks_raw).unwrap_or_default(),
        weeks_str: r.get(8)?,
        room: r.get(9)?,
        building: r.get(10)?,
        campus: r.get(11)?,
        course_name: r.get(12)?,
        course_code: r.get(13)?,
        credits: r.get(14)?,
        teachers: teachers_raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        course_type: r.get(16)?,
        color: r.get(17)?,
    })
}

fn load_sessions(conn: &Connection, account_id: i64, semester_id: i64) -> Result<Vec<CampusSession>> {
    let sql = format!(
        "{SESSION_SELECT} WHERE s.account_id = ?1 AND s.semester_id = ?2 \
         ORDER BY s.weekday, s.start_time, c.course_name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id, semester_id], session_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn semester_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CampusSemester> {
    Ok(CampusSemester {
        id: r.get(0)?,
        account_id: r.get(1)?,
        remote_id: r.get(2)?,
        code: r.get(3)?,
        name: r.get(4)?,
        school_year: r.get(5)?,
        season: r.get(6)?,
        start_date: r.get(7)?,
        end_date: r.get(8)?,
        week_start_on_sunday: r.get::<_, i64>(9)? != 0,
        total_weeks: r.get(10)?,
        current_week: r.get(11)?,
        is_current: r.get::<_, i64>(12)? != 0,
    })
}

const SEMESTER_SELECT: &str = "SELECT id, account_id, remote_id, code, name, school_year, season, \
     start_date, end_date, week_start_on_sunday, total_weeks, current_week, is_current";

fn load_semester(conn: &Connection, account_id: i64, semester_id: i64) -> Result<CampusSemester> {
    let sql = format!("{SEMESTER_SELECT} FROM campus_semesters WHERE account_id = ?1 AND id = ?2");
    conn.query_row(&sql, rusqlite::params![account_id, semester_id], semester_from_row)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                ReinError::Message("学期不存在，请先同步课表".into())
            }
            other => ReinError::from(other),
        })
}

fn load_all_semesters(conn: &Connection, account_id: i64) -> Result<Vec<CampusSemester>> {
    let sql = format!(
        "{SEMESTER_SELECT} FROM campus_semesters WHERE account_id = ?1 ORDER BY start_date DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], semester_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 当前学期（`is_current = 1`），没有则退化为最近的一个。
fn current_semester_id(conn: &Connection, account_id: i64) -> Result<Option<i64>> {
    let cur: Option<i64> = conn
        .query_row(
            "SELECT id FROM campus_semesters WHERE account_id = ?1 AND is_current = 1 LIMIT 1",
            [account_id],
            |r| r.get(0),
        )
        .ok();
    if cur.is_some() {
        return Ok(cur);
    }
    Ok(conn
        .query_row(
            "SELECT id FROM campus_semesters WHERE account_id = ?1 ORDER BY start_date DESC LIMIT 1",
            [account_id],
            |r| r.get(0),
        )
        .ok())
}

fn load_courses(conn: &Connection, account_id: i64, semester_id: i64) -> Result<Vec<CampusCourse>> {
    let mut stmt = conn.prepare(
        "SELECT id, semester_id, remote_lesson_id, course_code, course_name, lesson_code, \
         teachers, credits, course_type, color, lesson_name FROM campus_courses \
         WHERE account_id = ?1 AND semester_id = ?2 ORDER BY course_name",
    )?;
    let rows = stmt.query_map([account_id, semester_id], |r| {
        let teachers: Option<String> = r.get(6)?;
        Ok(CampusCourse {
            id: r.get(0)?,
            semester_id: r.get(1)?,
            remote_lesson_id: r.get(2)?,
            course_code: r.get(3)?,
            course_name: r.get(4)?,
            lesson_code: r.get(5)?,
            teachers: teachers
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            credits: r.get(7)?,
            course_type: r.get(8)?,
            color: r.get(9)?,
            lesson_name: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 把课表展开成「日期 → 当天发生的课」。Rust 侧唯一一处做周次换算的地方，视图与
/// 时间线物化共用它，避免两边公式漂移。
fn expand_entries(sem: &CampusSemester, sessions: &[CampusSession]) -> Vec<ScheduleEntry> {
    let Some(anchor) = semester_anchor(sem) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for s in sessions {
        for &w in &s.weeks {
            let Some(d) = occurrence_date(anchor, w, s.weekday, sem.week_start_on_sunday) else {
                continue;
            };
            out.push(ScheduleEntry {
                date: d.format("%Y-%m-%d").to_string(),
                week: w,
                session: s.clone(),
            });
        }
    }
    out.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.session.start_time.cmp(&b.session.start_time))
    });
    out
}

/// 左侧时间轴：按**节次区间**去重后升序。
///
/// 用节次区间（而不是时间）做去重键：区间才是行的身份，时间只是它的展示。
/// 前端用它当周视图的行轴，所以同一区间必须只出现一行，否则课会被画到两行上。
fn build_time_slots(sessions: &[CampusSession]) -> Vec<TimeSlot> {
    let mut seen = HashSet::new();
    let mut slots: Vec<TimeSlot> = Vec::new();
    for s in sessions {
        if !seen.insert((s.start_unit, s.end_unit)) {
            continue;
        }
        let (Some(sm), Some(em)) = (
            guet::hhmm_to_min(&s.start_time),
            guet::hhmm_to_min(&s.end_time),
        ) else {
            continue;
        };
        slots.push(TimeSlot {
            start_unit: s.start_unit,
            end_unit: s.end_unit,
            start_time: s.start_time.clone(),
            end_time: s.end_time.clone(),
            start_min: sm,
            duration_min: (em - sm).max(0),
        });
    }
    slots.sort_by_key(|s| s.start_min);
    slots
}

/* ─────────────────────────── 时间线物化 ─────────────────────────── */

/// 派生行的备注：把「第几节 · 教室 · 教师」压成一行，时间轴上不开详情就能看清。
fn class_notes(s: &CampusSession) -> Option<String> {
    let mut bits: Vec<String> = Vec::new();
    if s.start_unit > 0 && s.end_unit >= s.start_unit {
        bits.push(if s.start_unit == s.end_unit {
            format!("第{}节", s.start_unit)
        } else {
            format!("第{}-{}节", s.start_unit, s.end_unit)
        });
    }
    let place = match (s.building.as_deref(), s.room.as_deref()) {
        (Some(b), Some(r)) => Some(format!("{b} {r}")),
        (Some(b), None) => Some(b.to_string()),
        (None, Some(r)) => Some(r.to_string()),
        (None, None) => None,
    };
    if let Some(p) = place {
        bits.push(p);
    }
    if !s.teachers.is_empty() {
        bits.push(s.teachers.join("、"));
    }
    if bits.is_empty() {
        None
    } else {
        Some(bits.join(" · "))
    }
}

/// 重建课表在时间线上的派生行，返回写入条数。
///
/// 语义与 `program_schedule_replace` 同款：**先删后建**（幂等）。但多一条不变量——
/// `status = 'done'` 的历史行永不删除，且重建时跳过「已存在完成行」的发生，
/// 否则用户打过卡的课会被重新创建成未完成态，出现同日重复两行。
fn materialize_todos(
    conn: &Connection,
    account_id: i64,
    sem: &CampusSemester,
    sessions: &[CampusSession],
) -> Result<i64> {
    conn.execute(
        "DELETE FROM todos WHERE status != 'done' AND course_session_id IN \
         (SELECT id FROM campus_sessions WHERE account_id = ?1)",
        [account_id],
    )?;

    let mut done: HashSet<(i64, String)> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT t.course_session_id, t.date FROM todos t \
             WHERE t.status = 'done' AND t.course_session_id IN \
             (SELECT id FROM campus_sessions WHERE account_id = ?1)",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            done.insert(row?);
        }
    }

    let today = Local::now().date_naive();
    let from = today - Duration::days(MATERIALIZE_BACK_DAYS);
    let to = today + Duration::days(MATERIALIZE_FORWARD_DAYS);
    let now = now_iso();
    let mut written = 0i64;

    for entry in expand_entries(sem, sessions) {
        let Some(d) = guet::parse_ymd(&entry.date) else {
            continue;
        };
        if d < from || d > to || done.contains(&(entry.session.id, entry.date.clone())) {
            continue;
        }
        let Some(start_min) = guet::hhmm_to_min(&entry.session.start_time) else {
            continue;
        };
        let duration = guet::hhmm_to_min(&entry.session.end_time)
            .map(|e| e - start_min)
            .filter(|d| *d > 0)
            .unwrap_or(DEFAULT_CLASS_MIN);

        conn.execute(
            "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, \
             status, created_at, course_session_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'todo', ?7, ?8)",
            rusqlite::params![
                entry.session.course_name,
                class_notes(&entry.session),
                entry.date,
                start_min,
                duration,
                COURSE_CATEGORY,
                now,
                entry.session.id,
            ],
        )?;
        written += 1;
    }
    Ok(written)
}

/// 清理远端已消失的时段（换课 / 退课），返回被删掉的时段数。
///
/// **三步的顺序有讲究**，`todos.course_session_id` 是硬外键（本库未对 todos 开级联），
/// 所以删时段之前先把引用它的行安顿好：
/// 1. 未完成的派生行**直接删**——这些课已经不在课表上了，时间线上不该留；
/// 2. 已打卡的历史行**摘掉链接但保留行**——「done 行永不删」是本方案的核心不变量，
///    它与外键冲突时只能让历史行失去来源，绝不能连行一起删。摘链后 title/notes/date
///    仍在，只是不再被识别为课表派生行；
/// 3. 最后才删时段本身。
fn delete_stale_sessions(
    conn: &Connection,
    account_id: i64,
    semester_id: i64,
    kept: &[i64],
) -> Result<i64> {
    let stale_pred = if kept.is_empty() {
        "SELECT id FROM campus_sessions WHERE account_id = ? AND semester_id = ?".to_string()
    } else {
        let placeholders = vec!["?"; kept.len()].join(",");
        format!(
            "SELECT id FROM campus_sessions WHERE account_id = ? AND semester_id = ? \
             AND id NOT IN ({placeholders})"
        )
    };
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&account_id, &semester_id];
    for id in kept {
        params.push(id);
    }

    let stale_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM ({stale_pred})"),
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;
    if stale_count == 0 {
        return Ok(0);
    }

    conn.execute(
        &format!(
            "DELETE FROM todos WHERE status != 'done' AND course_session_id IN ({stale_pred})"
        ),
        rusqlite::params_from_iter(params.iter()),
    )?;
    conn.execute(
        &format!(
            "UPDATE todos SET course_session_id = NULL \
             WHERE status = 'done' AND course_session_id IN ({stale_pred})"
        ),
        rusqlite::params_from_iter(params.iter()),
    )?;
    conn.execute(
        &format!("DELETE FROM campus_sessions WHERE id IN ({stale_pred})"),
        rusqlite::params_from_iter(params.iter()),
    )?;
    Ok(stale_count)
}

/* ─────────────────────────── 学校系统 / 账号 ─────────────────────────── */

/// 学校系统选择器的数据源。
#[tauri::command]
pub fn campus_systems() -> Vec<SchoolSystemInfo> {
    provider::list_info()
}

/// 当前激活账号（密码与 Cookie 不出 Rust）。
#[tauri::command]
pub fn campus_account_get(state: State<AppState>) -> Result<Option<CampusAccount>> {
    let conn = state.db.lock().unwrap();
    Ok(load_active_account(&conn)?.map(to_account))
}

/// 取图形验证码，返回**裸 base64**（不带 `data:` 前缀），前端自行拼 data URL。
///
/// 顺带把 salt 与本次会话的 Cookie 存进 [`CampusHub`]：树维把验证码答案绑在会话上，
/// 提交登录必须复用同一个会话，否则必然对不上。用户重新取图时覆盖旧值。
#[tauri::command]
pub async fn campus_captcha(
    hub: State<'_, CampusHub>,
    system_kind: String,
    base_url: String,
    login_name: String,
) -> Result<String> {
    let spec = provider::spec(&system_kind)
        .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{system_kind}")))?;
    let base = base_url.trim().to_string();
    if base.is_empty() {
        return Err(ReinError::Message("服务地址不能为空".into()));
    }
    let key = format!("{base}|{login_name}");

    let (image, pending) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, PendingLogin)> {
            let mut session = Session::new(&base, CookieJar::default());

            // 先把 salt 取回来：这一步同时建立了会话（响应会 Set-Cookie），
            // 之后的验证码 GET 才会挂在同一个会话上。
            let salt_resp = session.get(spec.login.salt_path())?;
            if !salt_resp.is_ok() {
                return Err(ReinError::Message(format!(
                    "获取登录盐值失败：HTTP {}",
                    salt_resp.status
                )));
            }
            if salt_resp.text().trim().is_empty() {
                return Err(ReinError::Message("登录盐值为空，教务系统可能已改版".into()));
            }

            let mut adapter = GuetAdapter::new(spec, &mut session);
            let image = adapter.fetch_captcha()?;

            Ok((
                image,
                PendingLogin {
                    key,
                    cookies: session.jar().clone(),
                },
            ))
        })
        .await
        .map_err(|e| ReinError::Message(format!("验证码任务失败：{e}")))??;

    *hub.pending.lock().unwrap() = Some(pending);
    Ok(image)
}

/// 登录。`password` 为空时回落到账号里已保存的密码（用于会话过期后的静默重登）。
// Tauri 命令参数必须拍平（前端按名传参），两个 State 注入项占掉了额度，无法靠参数结构体收敛。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn campus_login(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    system_kind: String,
    base_url: String,
    login_name: String,
    password: Option<String>,
    captcha: Option<String>,
    save_password: Option<bool>,
) -> Result<LoginOutcome> {
    let spec = provider::spec(&system_kind)
        .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{system_kind}")))?;
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err(ReinError::Message("服务地址不能为空".into()));
    }
    let login_name = login_name.trim().to_string();
    if login_name.is_empty() {
        return Err(ReinError::Message("学号不能为空".into()));
    }
    let key = format!("{base}|{login_name}");
    let want_save = save_password.unwrap_or(true);
    let captcha = captcha.unwrap_or_default();

    // 口令解析：优先用本次输入；没输入就回落到库里存的（重登场景）
    let plain = {
        let conn = state.db.lock().unwrap();
        let existing: Option<String> = conn
            .query_row(
                "SELECT password FROM campus_accounts WHERE base_url = ?1 AND login_name = ?2",
                rusqlite::params![base, login_name],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .filter(|p| !p.is_empty());
        match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => existing.ok_or_else(|| {
                ReinError::Message("请输入密码（该账号没有保存密码，无法自动重登）".into())
            })?,
        }
    };

    // 复用取验证码时建立的会话；没有（用户没走验证码流程，或换过学号）就是一个空 jar。
    // 适配器的 login() 会在这个会话上现取 salt 再加密提交，所以这里只需带对 Cookie。
    let pending = {
        let mut slot = hub.pending.lock().unwrap();
        match slot.as_ref() {
            Some(p) if p.key == key => slot.take(),
            _ => None,
        }
    };

    // 闭包要拿走这几个值，但下面写库还要用，所以先克隆一份进去。
    let base_for_io = base.clone();
    let name_for_io = login_name.clone();
    let plain_for_io = plain.clone();
    let (outcome, cookies) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(LoginOutcome, CookieJar)> {
            let jar = pending.map(|p| p.cookies).unwrap_or_default();
            let mut session = Session::new(&base, jar);
            let outcome = {
                let mut adapter = GuetAdapter::new(spec, &mut session);
                adapter.login(&login_name, &plain, &captcha)?
            };
            Ok((outcome, session.jar().clone()))
        })
        .await
        .map_err(|e| ReinError::Message(format!("登录任务失败：{e}")))??;
    let (base, login_name, plain) = (base_for_io, name_for_io, plain_for_io);

    if !outcome.ok {
        return Ok(outcome);
    }

    // 登录成功：落库。该账号置为激活，其余降级 —— 时间线只投影激活账号的课表，
    // 多账号可以并存但同一时刻只有一个在生效。
    let conn = state.db.lock().unwrap();
    let now = now_iso();
    // 「不保存密码」要真的把旧密码清掉，不能只写个标记位
    let stored_password: Option<&str> = if want_save { Some(&plain) } else { None };
    conn.execute(
        "INSERT INTO campus_accounts \
         (system_kind, base_url, login_name, password, cookies, session_at, save_password, active, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?6, ?6) \
         ON CONFLICT(base_url, login_name) DO UPDATE SET \
           system_kind = excluded.system_kind, \
           password = excluded.password, \
           cookies = excluded.cookies, \
           session_at = excluded.session_at, \
           save_password = excluded.save_password, \
           active = 1, updated_at = excluded.updated_at",
        rusqlite::params![
            spec.kind,
            base,
            login_name,
            stored_password,
            cookies.to_json(),
            now,
            want_save as i64,
        ],
    )?;
    // 用 (base_url, login_name) 回查真实 id：走 ON CONFLICT 分支时 last_insert_rowid
    // 不指向该账号，不能拿它当依据。
    let active_id: i64 = conn.query_row(
        "SELECT id FROM campus_accounts WHERE base_url = ?1 AND login_name = ?2",
        rusqlite::params![base, login_name],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE campus_accounts SET active = 0 WHERE id != ?1",
        [active_id],
    )?;
    let account = load_active_account(&conn)?.map(to_account);

    // 换了一次登录（Cookie 票据全新），拿旧会话换来的选课令牌也就作废了
    forget_select_token(&hub);

    Ok(LoginOutcome {
        ok: true,
        message: None,
        need_captcha: false,
        action_required: None,
        account,
    })
}

/// 会话是否仍然有效。
#[tauri::command]
pub async fn campus_session_probe(state: State<'_, AppState>) -> Result<bool> {
    let account = {
        let conn = state.db.lock().unwrap();
        require_account(&conn)?
    };
    let spec = account.spec()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool> {
        let mut session = account.session();
        GuetAdapter::new(spec, &mut session).probe_session()
    })
    .await
    .map_err(|e| ReinError::Message(format!("会话探测失败：{e}")))?
}

/* ───────────────── 账号生命周期（刻意抽成纯函数：这三段的语义是声明过的，
   而命令层拿不到 State，抽出来才测得了） ───────────────── */

/// 退出登录：只清会话，**保留课表快照与已生成的时间线**（转为只读快照）。
/// 想彻底清数据走 [`delete_account_data`]。
fn clear_session(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE campus_accounts SET cookies = NULL, session_at = NULL, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now_iso(), account_id],
    )?;
    Ok(())
}

/// 删除账号：连同课表快照与全部派生日程一起清掉。
///
/// 本库没有对 `todos` 开外键级联，所以派生行必须显式删除
/// （`campus_sessions` / `campus_courses` / `campus_semesters` 由 FK 级联处理）。
fn delete_account_data(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM todos WHERE course_session_id IN \
         (SELECT id FROM campus_sessions WHERE account_id = ?1)",
        [account_id],
    )?;
    conn.execute("DELETE FROM campus_accounts WHERE id = ?1", [account_id])?;
    meta_set(conn, &program_cache_key(account_id), "")?;
    Ok(())
}

/// 切换当前学期：改标记 + 把「非当前学期」的未完成派生行清掉，
/// 否则两学期的课会叠在同一条时间线上。已完成的（done）保留为历史。
fn switch_semester(conn: &Connection, account_id: i64, semester_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM todos WHERE status != 'done' AND course_session_id IN \
         (SELECT id FROM campus_sessions WHERE account_id = ?1 AND semester_id != ?2)",
        rusqlite::params![account_id, semester_id],
    )?;
    conn.execute(
        "UPDATE campus_semesters SET is_current = 0 WHERE account_id = ?1",
        [account_id],
    )?;
    conn.execute(
        "UPDATE campus_semesters SET is_current = 1 WHERE id = ?1",
        [semester_id],
    )?;
    Ok(())
}

/// 退出登录：只清会话，**保留课表快照与已生成的时间线**（转为只读快照）。
/// 想彻底清数据走 `campus_account_delete`。
#[tauri::command]
pub fn campus_logout(state: State<AppState>, hub: State<CampusHub>) -> Result<()> {
    let conn = state.db.lock().unwrap();
    let account = require_account(&conn)?;
    clear_session(&conn, account.id)?;
    // 选课令牌是用会话换来的，会话没了它也就没有意义
    *hub.select_token.lock().unwrap() = None;
    Ok(())
}

/// 删除账号：连同课表快照与全部派生日程一起清掉。
#[tauri::command]
pub fn campus_account_delete(state: State<AppState>) -> Result<()> {
    let conn = state.db.lock().unwrap();
    let Some(account) = load_active_account(&conn)? else {
        return Ok(());
    };
    delete_account_data(&conn, account.id)
}

/* ─────────────────────────── 学期 ─────────────────────────── */

#[tauri::command]
pub fn campus_semesters(state: State<AppState>) -> Result<Vec<CampusSemester>> {
    let conn = state.db.lock().unwrap();
    let Some(account) = load_active_account(&conn)? else {
        return Ok(Vec::new());
    };
    load_all_semesters(&conn, account.id)
}

/// 切换当前学期 —— 只改标记，时间线由 `campus_sync` / `campus_schedule` 重新对齐。
#[tauri::command]
pub fn campus_set_current_semester(state: State<AppState>, semester_id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    let account = require_account(&conn)?;
    // 只做存在性校验，值本身用不上
    load_semester(&conn, account.id, semester_id)?;
    switch_semester(&conn, account.id, semester_id)
}

/* ─────────────────────────── 同步 ─────────────────────────── */

/// 同步阶段在无锁区间里攒下的全部产物。
struct Fetched {
    cookies: CookieJar,
    semesters: Vec<RemoteSemester>,
    snapshot: TimetableSnapshot,
    target_remote_id: i64,
}

/// 一次抓取尝试：结果 + 「中途换过会话」的痕迹。
///
/// 换过会话就必须落库，**哪怕这次抓取最后还是失败了** ——
/// 否则下次又从零重登一遍，用户看到的还是那句「会话过期，请重新登录」。
struct SyncAttempt {
    fetched: Result<Fetched>,
    refreshed: Option<CookieJar>,
}

/// 一次完整的课表抓取：课表页面变量 → 选定学期 → 课表数据。
///
/// 单独抽出来是因为它可能被跑两遍 —— 302 会出现在这三步里的任何一步，
/// 只在开头探一次针是拦不住「半程才过期」的。
fn fetch_snapshot(
    spec: &'static SchoolSystemSpec,
    session: &mut Session,
    wanted_remote: Option<i64>,
) -> Result<(Vec<RemoteSemester>, TimetableSnapshot, i64)> {
    let mut adapter = GuetAdapter::new(spec, session);
    let vars = adapter.fetch_page_vars()?;
    let today = Local::now().date_naive();

    // 选目标学期：显式指定 > 覆盖今天的 > 起始日最晚的
    let target = vars
        .semesters
        .iter()
        .find(|s| wanted_remote == Some(s.id))
        .or_else(|| {
            vars.semesters.iter().find(|s| {
                match (
                    guet::parse_ymd(s.start_date.as_deref().unwrap_or("")),
                    guet::parse_ymd(s.end_date.as_deref().unwrap_or("")),
                ) {
                    (Some(a), Some(b)) => a <= today && today <= b,
                    _ => false,
                }
            })
        })
        .or_else(|| {
            vars.semesters.iter().max_by_key(|s| {
                guet::parse_ymd(s.start_date.as_deref().unwrap_or("")).unwrap_or(today)
            })
        })
        .ok_or_else(|| ReinError::Message("教务系统没有返回可用学期".into()))?;
    let target_remote_id = target.id;

    let snapshot = adapter.fetch_timetable(target_remote_id)?;
    Ok((vars.semesters, snapshot, target_remote_id))
}

/// 远端学期换算成本地记录所需的字段。
struct LocalSemester {
    name: String,
    end_date: String,
    week_start_on_sunday: bool,
    total_weeks: i64,
    current_week: Option<i64>,
}

/// 缺起止日期的学期直接跳过 —— 没有锚点就无法把课落到日历上，存下来也是个死记录。
fn remote_to_local(
    remote: &RemoteSemester,
    spec: &'static SchoolSystemSpec,
    today: NaiveDate,
) -> Option<LocalSemester> {
    let start = guet::parse_ymd(remote.start_date.as_deref()?)?;
    let end = guet::parse_ymd(remote.end_date.as_deref()?)?;
    if end < start {
        return None;
    }
    Some(LocalSemester {
        name: guet::semester_display_name(
            remote.school_year.as_deref(),
            remote.season.as_deref(),
            // 拼不出中文名时退到教务的英文名，再退到学期代码
            remote
                .name_en
                .as_deref()
                .or(remote.code.as_deref())
                .unwrap_or("未命名学期"),
        ),
        end_date: remote.end_date.clone().unwrap_or_default(),
        week_start_on_sunday: remote
            .week_start_on_sunday
            .unwrap_or(spec.term.week_start_on_sunday),
        total_weeks: guet::total_weeks(start, end),
        current_week: guet::current_week(start, end, today),
    })
}

/// 同步课表：拉课表（会话过期就自愈重试一次）→ 落库 → 重建时间线派生行。
#[tauri::command]
pub async fn campus_sync(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    semester_id: Option<i64>,
) -> Result<SyncOutcome> {
    // ── 短锁：取出账号，并把「本地学期 id」翻译成本次抓取要用的远端 id
    let (account, wanted_remote) = {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        let wanted = match semester_id {
            Some(local_id) => Some(load_semester(&conn, account.id, local_id)?.remote_id),
            None => None,
        };
        (account, wanted)
    };
    let spec = account.spec()?;
    // account 马上要被搬进闭包，写库阶段还要用 id，所以先取出来
    let account_id = account.id;

    // ── 无锁：网络抓取（撞上会话过期就原地自愈一次）
    let attempt = tauri::async_runtime::spawn_blocking(move || -> SyncAttempt {
        let mut session = account.session();
        let mut refreshed: Option<CookieJar> = None;

        let mut fetched = fetch_snapshot(spec, &mut session, wanted_remote);
        if matches!(&fetched, Err(e) if is_session_lost(e)) {
            match relogin(&account) {
                Ok(jar) => {
                    // 换上新会话把整段重跑。新 Cookie 由命令层落库，这里不碰 DB
                    // （慢网络与 DB 锁不许同时持有，见文件头）。
                    session = Session::new(&account.base_url, jar.clone());
                    refreshed = Some(jar);
                    fetched = fetch_snapshot(spec, &mut session, wanted_remote);
                }
                Err(e) => fetched = Err(e),
            }
        }

        SyncAttempt {
            fetched: fetched.map(|(semesters, snapshot, target_remote_id)| Fetched {
                cookies: session.jar().clone(),
                semesters,
                snapshot,
                target_remote_id,
            }),
            refreshed,
        }
    })
    .await
    .map_err(|e| ReinError::Message(format!("同步任务失败：{e}")))?;

    // ── 短锁：落库 + 重建时间线
    let conn = state.db.lock().unwrap();

    // 中途换过会话就先把它写死：这一步之后再出闪失，也不至于白换一次
    // （下一次调用——包括培养方案、选课、抢课引擎——直接就能用上新会话）。
    if let Some(jar) = &attempt.refreshed {
        persist_session(&conn, account_id, jar)?;
        forget_select_token(&hub);
    }
    let fetched = attempt.fetched?;

    let today = Local::now().date_naive();
    let now = now_iso();

    for remote in &fetched.semesters {
        let Some(local) = remote_to_local(remote, spec, today) else {
            continue;
        };
        let is_current = (remote.id == fetched.target_remote_id) as i64;
        conn.execute(
            "INSERT INTO campus_semesters \
             (account_id, remote_id, code, name, school_year, season, start_date, end_date, \
              week_start_on_sunday, total_weeks, current_week, is_current) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(account_id, remote_id) DO UPDATE SET \
               code = excluded.code, name = excluded.name, school_year = excluded.school_year, \
               season = excluded.season, start_date = excluded.start_date, \
               end_date = excluded.end_date, week_start_on_sunday = excluded.week_start_on_sunday, \
               total_weeks = excluded.total_weeks, current_week = excluded.current_week, \
               is_current = excluded.is_current",
            rusqlite::params![
                account_id,
                remote.id,
                remote.code,
                local.name,
                remote.school_year,
                remote.season,
                remote.start_date,
                local.end_date,
                local.week_start_on_sunday as i64,
                local.total_weeks,
                local.current_week,
                is_current,
            ],
        )?;
    }
    // 目标学期以外的都取消当前标记，保证 is_current 唯一
    conn.execute(
        "UPDATE campus_semesters SET is_current = 0 WHERE account_id = ?1 AND remote_id != ?2",
        rusqlite::params![account_id, fetched.target_remote_id],
    )?;
    let semester_local_id: i64 = conn.query_row(
        "SELECT id FROM campus_semesters WHERE account_id = ?1 AND remote_id = ?2",
        rusqlite::params![account_id, fetched.target_remote_id],
        |r| r.get(0),
    )?;

    // 课程 + 上课时段
    let mut skipped = 0i64;
    let mut course_ids: HashMap<i64, i64> = HashMap::new();
    let mut kept_session_ids: Vec<i64> = Vec::new();

    for act in &fetched.snapshot.activities {
        let Some(lesson_id) = act.lesson_id else {
            skipped += 1;
            continue;
        };
        // 缺周次/星期/时间的记录进不了日历（例如纯考试安排），跳过并计数
        if act.week_indexes.is_empty()
            || act.weekday.is_none()
            || act.start_time.is_none()
            || act.end_time.is_none()
        {
            skipped += 1;
            continue;
        }
        let course_name = act
            .course_name
            .clone()
            .or_else(|| act.lesson_name.clone())
            .unwrap_or_else(|| "未命名课程".into());

        conn.execute(
            "INSERT INTO campus_courses \
             (account_id, semester_id, remote_lesson_id, course_code, course_name, lesson_code, \
              lesson_name, teachers, credits, course_type, color) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
             ON CONFLICT(account_id, semester_id, remote_lesson_id) DO UPDATE SET \
               course_code = excluded.course_code, course_name = excluded.course_name, \
               lesson_code = excluded.lesson_code, lesson_name = excluded.lesson_name, \
               teachers = excluded.teachers, credits = excluded.credits, \
               course_type = excluded.course_type, color = excluded.color",
            rusqlite::params![
                account_id,
                semester_local_id,
                lesson_id,
                act.course_code,
                course_name,
                act.lesson_code,
                act.lesson_name,
                serde_json::to_string(&act.teachers)?,
                act.credits,
                act.course_type.as_ref().and_then(|t| t.name_zh.clone()),
                act.bgc,
            ],
        )?;

        let course_id: i64 = conn.query_row(
            "SELECT id FROM campus_courses WHERE account_id = ?1 AND semester_id = ?2 AND remote_lesson_id = ?3",
            rusqlite::params![account_id, semester_local_id, lesson_id],
            |r| r.get(0),
        )?;
        course_ids.insert(lesson_id, course_id);

        conn.execute(
            "INSERT INTO campus_sessions \
             (account_id, semester_id, course_id, weekday, start_unit, end_unit, start_time, \
              end_time, weeks, weeks_str, room, building, campus) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
             ON CONFLICT(account_id, semester_id, course_id, weekday, start_unit, start_time) \
             DO UPDATE SET end_unit = excluded.end_unit, end_time = excluded.end_time, \
               weeks = excluded.weeks, weeks_str = excluded.weeks_str, room = excluded.room, \
               building = excluded.building, campus = excluded.campus",
            rusqlite::params![
                account_id,
                semester_local_id,
                course_id,
                act.weekday,
                act.start_unit.unwrap_or(0),
                act.end_unit.unwrap_or(0),
                act.start_time,
                act.end_time,
                serde_json::to_string(&act.week_indexes)?,
                act.weeks_str,
                act.room,
                act.building,
                act.campus,
            ],
        )?;
        let sid: i64 = conn.query_row(
            "SELECT id FROM campus_sessions WHERE account_id = ?1 AND semester_id = ?2 \
             AND course_id = ?3 AND weekday = ?4 AND start_unit = ?5 AND start_time = ?6",
            rusqlite::params![
                account_id,
                semester_local_id,
                course_id,
                act.weekday,
                act.start_unit.unwrap_or(0),
                act.start_time,
            ],
            |r| r.get(0),
        )?;
        kept_session_ids.push(sid);
    }

    // 远端已消失的时段（换课/退课）
    delete_stale_sessions(&conn, account_id, semester_local_id, &kept_session_ids)?;

    // 账号档案 + 会话
    conn.execute(
        "UPDATE campus_accounts SET cookies = ?1, session_at = ?2, student_id = ?3, \
         student_code = ?4, student_name = ?5, department = ?6, major = ?7, adminclass = ?8, \
         grade = ?9, total_credits = ?10, last_sync_at = ?2, updated_at = ?2 WHERE id = ?11",
        rusqlite::params![
            fetched.cookies.to_json(),
            now,
            fetched.snapshot.student_id,
            fetched.snapshot.student_code,
            fetched.snapshot.student_name,
            fetched.snapshot.department,
            fetched.snapshot.major,
            fetched.snapshot.adminclass,
            fetched.snapshot.grade,
            fetched.snapshot.total_credits,
            account_id,
        ],
    )?;

    let semester = load_semester(&conn, account_id, semester_local_id)?;
    let sessions = load_sessions(&conn, account_id, semester_local_id)?;
    let todos_written = materialize_todos(&conn, account_id, &semester, &sessions)?;

    Ok(SyncOutcome {
        courses: course_ids.len() as i64,
        sessions: sessions.len() as i64,
        todos_written,
        semester_id: semester_local_id,
        semester_name: semester.name,
        synced_at: now,
        skipped_activities: skipped,
    })
}

/* ─────────────────────────── 课表视图 ─────────────────────────── */

/// 读课表。返回指定日期区间内的每一节课，以及左侧时间轴用的节次表。
///
/// 顺带把时间线窗口重新对齐到今天：物化窗口是「过去一周 + 未来五周」的滚动区间，
/// App 放几天再打开时窗口会漂移。这里重建一次（纯本地、幂等、百来行），
/// 让「打开课表 = 时间线也最新」这个不变量成立，代价远低于一次网络同步。
#[tauri::command]
pub fn campus_schedule(
    state: State<AppState>,
    semester_id: Option<i64>,
    from: Option<String>,
    to: Option<String>,
) -> Result<ScheduleView> {
    let conn = state.db.lock().unwrap();
    let account = load_active_account(&conn)?;
    let Some(account) = account else {
        return Ok(ScheduleView {
            account: None,
            semester: None,
            entries: Vec::new(),
            time_slots: Vec::new(),
            courses: Vec::new(),
        });
    };

    let Some(sem_id) = (match semester_id {
        Some(id) => Some(id),
        None => current_semester_id(&conn, account.id)?,
    }) else {
        return Ok(ScheduleView {
            account: Some(to_account(account)),
            semester: None,
            entries: Vec::new(),
            time_slots: Vec::new(),
            courses: Vec::new(),
        });
    };

    let sem = load_semester(&conn, account.id, sem_id)?;
    let sessions = load_sessions(&conn, account.id, sem_id)?;
    materialize_todos(&conn, account.id, &sem, &sessions)?;

    let today = Local::now().date_naive();
    let lo = from
        .as_deref()
        .and_then(guet::parse_ymd)
        .unwrap_or_else(|| today - Duration::days(MATERIALIZE_BACK_DAYS));
    let hi = to
        .as_deref()
        .and_then(guet::parse_ymd)
        .unwrap_or_else(|| today + Duration::days(MATERIALIZE_FORWARD_DAYS));
    let (lo_s, hi_s) = (
        lo.format("%Y-%m-%d").to_string(),
        hi.format("%Y-%m-%d").to_string(),
    );

    let entries = expand_entries(&sem, &sessions)
        .into_iter()
        .filter(|e| e.date >= lo_s && e.date <= hi_s)
        .collect();
    let time_slots = build_time_slots(&sessions);
    let courses = load_courses(&conn, account.id, sem_id)?;

    Ok(ScheduleView {
        account: Some(to_account(account)),
        semester: Some(sem),
        entries,
        time_slots,
        courses,
    })
}

/* ─────────────────────────── 培养方案 ─────────────────────────── */

fn program_cache_key(account_id: i64) -> String {
    format!("campus_program:{account_id}")
}

/// 培养方案一次拉取的结果 + 「中途换过会话」的痕迹（与 [`SyncAttempt`] 同理）。
struct ProgramAttempt {
    raw: Result<serde_json::Value>,
    refreshed: Option<CookieJar>,
}

/// 培养方案原始 JSON（响应可达 900KB+，拉一次落 `app_meta` 缓存，之后离线可读）。
/// `refresh = true` 时强制重拉。
#[tauri::command]
pub async fn campus_program(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    refresh: Option<bool>,
) -> Result<serde_json::Value> {
    let (account, cache_key, cached) = {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        let key = program_cache_key(account.id);
        let cached = meta_get(&conn, &key).filter(|s| !s.is_empty());
        (account, key, cached)
    };

    if !refresh.unwrap_or(false) {
        if let Some(raw) = cached {
            if let Ok(v) = serde_json::from_str(&raw) {
                return Ok(v);
            }
        }
    }

    let account_id = account.id;
    let student_id = account
        .student_id
        .clone()
        .ok_or_else(|| ReinError::Message("缺少学生标识，请先同步一次课表".into()))?;
    let spec = account.spec()?;

    // ── 无锁：拉取（会话过期就自愈一次）
    let attempt = tauri::async_runtime::spawn_blocking(move || -> ProgramAttempt {
        let mut session = account.session();
        let mut refreshed: Option<CookieJar> = None;

        let mut raw = {
            let mut adapter = GuetAdapter::new(spec, &mut session);
            adapter.fetch_program_info(&student_id)
        };
        if matches!(&raw, Err(e) if is_session_lost(e)) {
            match relogin(&account) {
                Ok(jar) => {
                    session = Session::new(&account.base_url, jar.clone());
                    refreshed = Some(jar);
                    raw = GuetAdapter::new(spec, &mut session).fetch_program_info(&student_id);
                }
                Err(e) => raw = Err(e),
            }
        }
        ProgramAttempt { raw, refreshed }
    })
    .await
    .map_err(|e| ReinError::Message(format!("培养方案任务失败：{e}")))?;

    if let Some(jar) = &attempt.refreshed {
        let conn = state.db.lock().unwrap();
        persist_session(&conn, account_id, jar)?;
        forget_select_token(&hub);
    }
    let raw = attempt.raw?;

    {
        let conn = state.db.lock().unwrap();
        meta_set(&conn, &cache_key, &serde_json::to_string(&raw)?)?;
    }
    Ok(raw)
}

/* ─────────────────────────── 选课（course-selection-api） ─────────────────────────── */

/// 一次选课调用的全套上下文：客户端 + 学生 id + 账号 id。
///
/// 抽出来是因为**抢课引擎也要用它**（见 `grab.rs`），而账号密码 / Cookie 这些
/// 只在 `AccountRow` 里流转的内部形状不该泄出本模块 —— 引擎只需要「能发请求」和「我是谁」。
pub(crate) struct SelectContext {
    pub client: CourseSelectClient,
    pub student_id: i64,
    pub account_id: i64,
}

/// 取选课上下文。缓存命中则零网络；未命中才去门户换一张令牌。
///
/// 收 `&Mutex<Connection>` 而不是 `&Connection`：这条路上有网络（换令牌、必要时重登），
/// 而网络期间绝不能攥着 DB 锁 —— 锁的进出由本函数自己安排。
pub(crate) fn select_context(db: &Mutex<Connection>, hub: &CampusHub) -> Result<SelectContext> {
    let account = {
        let conn = db.lock().unwrap();
        require_account(&conn)?
    };
    match build_select_context(hub, &account) {
        Ok(ctx) => Ok(ctx),
        // 令牌换不出来，十有八九是 EAMS 会话死了（`acquire` 见 302 就报这个）。
        // 先自愈再换一次 —— 抢课引擎走的也是这条路，所以它不会因为会话过期停摆。
        Err(e) if is_session_lost(&e) => {
            recover_session(db, hub, &account)?;
            // 重新读一次账号：新会话刚写进库里，手上这份还是旧的（旧 Cookie 换不出新令牌）
            let account = {
                let conn = db.lock().unwrap();
                require_account(&conn)?
            };
            build_select_context(hub, &account)
        }
        Err(e) => Err(e),
    }
}

/// 取上下文本身。抽出来是为了让上面那段「失败 → 自愈 → 重来一次」读起来像一句话。
fn build_select_context(hub: &CampusHub, account: &AccountRow) -> Result<SelectContext> {
    Ok(SelectContext {
        client: select_client(hub, account)?,
        student_id: select_student_id(account)?,
        account_id: account.id,
    })
}

/// 取选课客户端。缓存命中则零网络；未命中才去门户换一张令牌。
fn select_client(hub: &CampusHub, account: &AccountRow) -> Result<CourseSelectClient> {
    if let Some(token) = hub.cached_select_token(account.id) {
        return Ok(CourseSelectClient::with_token(&account.base_url, token));
    }
    let client = CourseSelectClient::acquire(
        &account.base_url,
        CookieJar::from_json(account.cookies.as_deref()),
    )?;
    *hub.select_token.lock().unwrap() = Some(CourseSelectToken {
        account_id: account.id,
        token: client.token().to_string(),
        expires_at: client.expires_at(),
    });
    Ok(client)
}

/// 选课子系统里的学生 id（`241250`）。取自课表同步时落下的 `student_id`，
/// 与 `print-data` 里的 `studentTableVms[0].id` 是同一个值。
fn select_student_id(account: &AccountRow) -> Result<i64> {
    account
        .student_id
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| ReinError::Message("缺少学生标识，请先同步一次课表".into()))
}

/// 选课子系统状态：令牌就绪情况 + 服务器时间 + 学生档案 + 开放中的批次。
///
/// **批次列表为空是正常状态**（大一新生还没轮到选课窗口时就是空的），不是错误 ——
/// 界面要把它讲成「当前没有开放的选课批次」，而不是「出错了」。
#[tauri::command]
pub async fn campus_course_select_status(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
) -> Result<CourseSelectStatus> {
    let client = select_context(&state.db, &hub)?.client;
    let entry_url = client.entry_url();

    // 无锁：拉状态
    let (server_time, student, turns) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, Option<serde_json::Value>, Vec<CourseSelectTurn>)> {
            let server_time = client.server_time()?;
            let students = client.students()?;
            let student = students.into_iter().next();
            let sid = student
                .as_ref()
                .and_then(|s| s.get("id"))
                .and_then(|v| v.as_i64());
            let turns = match sid {
                Some(id) => client.open_turns(id)?,
                None => Vec::new(),
            };
            Ok((server_time, student, turns))
        },
    )
    .await
    .map_err(|e| ReinError::Message(format!("选课状态任务失败：{e}")))??;

    Ok(CourseSelectStatus {
        ready: true,
        reason: None,
        server_time: Some(server_time),
        student_id: student.as_ref().and_then(|s| s.get("id")).and_then(|v| v.as_i64()),
        student_code: student
            .as_ref()
            .and_then(|s| s.get("code"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        student_name: student
            .as_ref()
            .and_then(|s| s.get("person"))
            .and_then(|p| p.get("nameZh"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        turns,
        entry_url: Some(entry_url),
    })
}

/// 查询教学班（查课/筛课）。
#[tauri::command]
pub async fn campus_course_select_lessons(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    query: Option<LessonQuery>,
) -> Result<Vec<CourseSelectLesson>> {
    let ctx = select_context(&state.db, &hub)?;
    let query = query.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        ctx.client.query_lesson(ctx.student_id, &turn_id, &query)
    })
    .await
    .map_err(|e| ReinError::Message(format!("查询教学班失败：{e}")))?
}

/// 快速抢课的轻量课程列表。比 `query-lesson` 少一堆渲染字段，用来做「还有余量吗」的高频核对。
#[tauri::command]
pub async fn campus_course_select_simplest_lessons(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
) -> Result<Vec<CourseSelectLesson>> {
    let ctx = select_context(&state.db, &hub)?;
    tauri::async_runtime::spawn_blocking(move || ctx.client.simplest_lessons(&turn_id))
        .await
        .map_err(|e| ReinError::Message(format!("查询课程列表失败：{e}")))?
}

/// 该批次的查询表单定义（有哪些可筛选字段、默认怎么排序）。
///
/// 纯展示用：拿不到就当没有，**绝不因为它失败而挡住查课**。
#[tauri::command]
pub async fn campus_course_select_query_condition(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
) -> Result<serde_json::Value> {
    let ctx = select_context(&state.db, &hub)?;
    tauri::async_runtime::spawn_blocking(move || ctx.client.query_condition(&turn_id))
        .await
        .map_err(|e| ReinError::Message(format!("获取查询条件失败：{e}")))?
}

/// 提交选课。返回受理回执，**结果要轮询** [`campus_course_select_result`]。
#[tauri::command]
pub async fn campus_course_select_apply(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    lesson_id: serde_json::Value,
    virtual_cost: Option<i64>,
    schedule_group_id: Option<serde_json::Value>,
) -> Result<CourseSelectTicket> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let request_id = ctx.client.add_request(
            ctx.student_id,
            &turn_id,
            vec![AddItem {
                lesson_assoc: lesson_id,
                virtual_cost,
                schedule_group_assoc: schedule_group_id,
                need_attend: None,
            }],
            None,
        )?;
        if request_id.is_empty() {
            return Err(ReinError::Message("教务未返回受理编号，请稍后重试".into()));
        }
        Ok(CourseSelectTicket { request_id })
    })
    .await
    .map_err(|e| ReinError::Message(format!("提交选课失败：{e}")))?
}

/// 提交占位（`add-predicate`）。开窗瞬间先占住队列位次，不花意愿值。
///
/// 结果同样走 [`campus_course_select_result`]（服务端用同一套受理单）。
#[tauri::command]
pub async fn campus_course_select_predicate(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    lesson_id: serde_json::Value,
    schedule_group_id: Option<serde_json::Value>,
) -> Result<CourseSelectTicket> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let request_id = ctx.client.add_predicate(
            ctx.student_id,
            &turn_id,
            vec![AddItem {
                lesson_assoc: lesson_id,
                virtual_cost: None,
                schedule_group_assoc: schedule_group_id,
                need_attend: None,
            }],
            None,
        )?;
        if request_id.is_empty() {
            return Err(ReinError::Message("教务未返回受理编号，请稍后重试".into()));
        }
        Ok(CourseSelectTicket { request_id })
    })
    .await
    .map_err(|e| ReinError::Message(format!("提交占位失败：{e}")))?
}

/// 轮询选课/退课结果。`pending = true` 时前端隔 2 秒再问（SPA 最多 10 次）。
#[tauri::command]
pub async fn campus_course_select_result(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    request_id: String,
) -> Result<CourseSelectPoll> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let raw = ctx.client.add_drop_response(ctx.student_id, &request_id)?;
        Ok(poll_of(raw))
    })
    .await
    .map_err(|e| ReinError::Message(format!("查询选课结果失败：{e}")))?
}

/// 轮询占位结果（`predicate-response`）。
#[tauri::command]
pub async fn campus_course_select_predicate_result(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    request_id: String,
) -> Result<CourseSelectPoll> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let raw = ctx.client.predicate_response(ctx.student_id, &request_id)?;
        Ok(poll_of(raw))
    })
    .await
    .map_err(|e| ReinError::Message(format!("查询占位结果失败：{e}")))?
}

/// 原始响应 → [`CourseSelectPoll`]。`data` 为空即「服务端还在处理」。
fn poll_of(raw: serde_json::Value) -> CourseSelectPoll {
    if raw.is_null() {
        return CourseSelectPoll {
            pending: true,
            success: false,
            message: None,
            need_attend: false,
        };
    }
    let r: CourseSelectResult = serde_json::from_value(raw).unwrap_or(CourseSelectResult {
        success: false,
        error_message: None,
        resend: false,
    });
    CourseSelectPoll {
        pending: false,
        success: r.success,
        message: r.error_message.and_then(|m| m.text),
        need_attend: r.resend,
    }
}

/// 每轮退课轮询的等待、以及最多问几次。与选课同节奏（SPA 用 2 秒 × 10）。
const DROP_POLL_WAIT: std::time::Duration = std::time::Duration::from_millis(2000);
const DROP_POLL_MAX: usize = 10;

/// 退课：`drop-predicate`（意向）→ 轮询 `predicate-response` → `drop-request`（正式）→ 轮询结果。
///
/// **两条腿一次性走完**，而不是像选课那样把受理号抛给前端：退课是用户明确按下的一个按钮，
/// 中间那个「意向已登记、还没正式退」的中间态对用户没有任何意义，暴露出来只会让人误以为退掉了。
/// 选课可以异步（要抢时间），退课不行（退错了比选不上严重得多）。
#[tauri::command]
pub async fn campus_course_select_drop(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    lesson_ids: Vec<serde_json::Value>,
    confirm_midterm_retake: Option<bool>,
) -> Result<CourseSelectPoll> {
    if lesson_ids.is_empty() {
        return Err(ReinError::Message("没有指定要退的教学班".into()));
    }
    let ctx = select_context(&state.db, &hub)?;
    let midterm = confirm_midterm_retake.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || -> Result<CourseSelectPoll> {
        // ① 登记退课意向
        let intend = ctx
            .client
            .drop_predicate(ctx.student_id, &turn_id, &lesson_ids)?;
        if intend.is_empty() {
            return Err(ReinError::Message("教务未受理退课意向，请稍后重试".into()));
        }
        wait_settled(&ctx, &intend, true)?;

        // ② 正式退课
        let request_id =
            ctx.client
                .drop_request(ctx.student_id, &turn_id, &lesson_ids, None, midterm)?;
        if request_id.is_empty() {
            return Err(ReinError::Message("教务未返回退课受理编号，请稍后重试".into()));
        }

        // ③ 等结果
        for _ in 0..DROP_POLL_MAX {
            let raw = ctx.client.add_drop_response(ctx.student_id, &request_id)?;
            let poll = poll_of(raw);
            if !poll.pending {
                return Ok(CourseSelectPoll {
                    message: poll.message.or_else(|| {
                        poll.success.then(|| "已退课".to_string())
                    }),
                    ..poll
                });
            }
            std::thread::sleep(DROP_POLL_WAIT);
        }
        Err(ReinError::Message(
            "教务迟迟没有返回退课结果，请到官方选课页确认后再试".into(),
        ))
    })
    .await
    .map_err(|e| ReinError::Message(format!("退课失败：{e}")))?
}

/// 等一张受理单落定。`pending` 直到超时，超时不报错 —— 由调用方按业务决定要不要继续。
fn wait_settled(
    ctx: &SelectContext,
    request_id: &str,
    predicate: bool,
) -> Result<()> {
    for _ in 0..DROP_POLL_MAX {
        let raw = if predicate {
            ctx.client.predicate_response(ctx.student_id, request_id)?
        } else {
            ctx.client.add_drop_response(ctx.student_id, request_id)?
        };
        if !raw.is_null() {
            return Ok(());
        }
        std::thread::sleep(DROP_POLL_WAIT);
    }
    Err(ReinError::Message(
        "教务迟迟没有受理，请到官方选课页确认状态后再试".into(),
    ))
}

/* ─────────────────────────── 自动抢课（任务单 + 后台引擎） ───────────────────────────
 *
 * 引擎本身在 `grab.rs`（后台线程，见那里的模块文档）。这里只提供「改任务单」的命令：
 * 所有写操作都以**改库 + 叫醒引擎**收尾，界面因此永远是「按下就生效」的手感。
 */

/// 任务单快照。与引擎推来的事件同形（`grab::snapshot`），
/// 所以前端可以用同一段渲染逻辑处理「主动拉」与「被动推」。
#[tauri::command]
pub fn campus_grab_state(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<GrabState> {
    let conn = state.db.lock().unwrap();
    grab::snapshot(&conn, &grab)
}

/// 把一批课程加入抢课任务单。
///
/// `window_wall` 传 `null` 表示「还不知道窗口什么时候开」—— 引擎不会盲撞，
/// 而是每分钟去问一次 `open-turns`，拿到时间再精确开火（见 `grab::fire_at_ms`）。
// 同 campus_login：Tauri 命令参数拍平，三个 State 注入项占掉额度。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn campus_grab_enqueue(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    grab: State<'_, Arc<GrabHub>>,
    turn_id: String,
    turn_name: Option<String>,
    targets: Vec<GrabTargetInput>,
    mode: Option<String>,
    window_wall: Option<String>,
    window_end_wall: Option<String>,
) -> Result<Vec<i64>> {
    if targets.is_empty() {
        return Err(ReinError::Message("没有要抢的课程".into()));
    }
    let mode = match mode.as_deref() {
        // 默认占位优先：开窗瞬间先占住位次，再用正式请求确认 —— 抢的是位次
        None | Some("predicate") => "predicate",
        Some("direct") => "direct",
        Some(other) => {
            return Err(ReinError::Message(format!("未知的抢课模式：{other}")));
        }
    };
    let window = window_wall.as_deref().filter(|s| !s.trim().is_empty());
    let window_end = window_end_wall.as_deref().filter(|s| !s.trim().is_empty());

    let ids = {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        let mut ids = Vec::with_capacity(targets.len());
        for t in &targets {
            ids.push(grab::insert_task(
                &conn,
                account.id,
                &turn_id,
                turn_name.as_deref(),
                t,
                mode,
                window,
                window_end,
            )?);
        }
        ids
    };

    // 「进批次」是拿到提交体所需批次 id（`options.turn.id`）的唯一途径。
    // 放在入队时做、每门课共用一次结果：窗口开放后引擎不必再多一次往返，
    // 而那一次往返正好发生在最不该浪费时间的时刻。
    //
    // **失败不算错**：拿不到就留空，提交时退回列表 id（见 `GrabTask::turn_assoc`）。
    // 入队不该因为教务抖一下而失败 —— 用户排的任务单照样该进队列。
    let ctx = select_context(&state.db, &hub).ok();
    if let Some(ctx) = ctx {
        let tid = turn_id.clone();
        // 无锁联网，且不占 IPC 线程：这一步正常 200ms，超时上限 12s
        if let Ok(assoc) = tauri::async_runtime::spawn_blocking(move || {
            ctx.client.turn_assoc(ctx.student_id, &tid)
        })
        .await
        {
            let conn = state.db.lock().unwrap();
            for id in &ids {
                let _ = grab::set_turn_assoc(&conn, *id, &assoc);
            }
        }
    }

    grab.notify();
    Ok(ids)
}

/// 暂停 / 取消 / 重试 / 移除。四个动作都是「改个状态」，所以合成一条命令，
/// 前端只需记住动作名，不必为每个按钮各配一条 IPC。
#[tauri::command]
pub fn campus_grab_task_action(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    task_id: i64,
    action: String,
) -> Result<()> {
    {
        let conn = state.db.lock().unwrap();
        // 引擎可能正在跑这个任务，先确认它存在，免得改了个空气
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM campus_grab_tasks WHERE id = ?1",
                [task_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(ReinError::Message("任务不存在（可能已被清理）".into()));
        }
        match action.as_str() {
            "pause" => grab::set_status(&conn, task_id, GRAB_PAUSED)?,
            "cancel" => grab::set_status(&conn, task_id, GRAB_CANCELLED)?,
            // 重试 = 把计数与退避清零，回到队列尾重新排队。
            // 用户按它通常是「我知道刚才是怎么回事了」，所以连 strikes 一起清掉；
            // `predicate_done` 也一并复位 —— 重新排队是一轮全新的抢课，占位该重新交。
            "retry" => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', attempts = 0, \
                     polls = 0, strikes = 0, strike_kind = NULL, request_id = NULL, \
                     predicate_done = 0, finished_at = NULL, last_message = '已重新排队', \
                     next_at = ?3 WHERE id = ?1",
                    rusqlite::params![task_id, GRAB_WAITING, Utc::now().timestamp_millis()],
                )?;
            }
            "remove" => grab::delete_task(&conn, task_id)?,
            other => {
                return Err(ReinError::Message(format!("未知的操作：{other}")));
            }
        }
    }
    grab.notify();
    Ok(())
}

/// 清掉已结束的任务（成功/失败/冲突/已取消）。
#[tauri::command]
pub fn campus_grab_clear_finished(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<usize> {
    let n = {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        grab::clear_finished(&conn, account.id)?
    };
    grab.notify();
    Ok(n)
}

/* ─────────────────── 抢课计划（意向） ───────────────────
 *
 * 计划是「提前输入」的落点：窗口开放前教学班列表常常还查不到，但人的意图现在就能写下。
 * 写完之后**不需要用户再做任何事** —— 引擎每分钟试一次，名单能拉到的那一刻自己解析成任务，
 * 到点自己开抢（见 `grab.rs` 的 `resolve_intent`）。
 */

/// 记下一条计划。`turn_id` 可为空（= 用教务当前开放的那个批次）——
/// 提前一晚写计划时，批次往往还没在列表里出现。
#[tauri::command]
pub fn campus_grab_intent_add(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    turn_id: Option<String>,
    turn_name: Option<String>,
    query: String,
    mode: Option<String>,
    spread: Option<bool>,
) -> Result<GrabIntent> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(ReinError::Message("要先写清楚想抢什么（课名 / 代码 / 教师）".into()));
    }
    // 上限是给误触和粘贴事故兜底的：一句正常的查询不会超过几十个字
    if query.chars().count() > 80 {
        return Err(ReinError::Message("这句话太长了，只写课名或教师就行".into()));
    }
    let mode = match mode.as_deref() {
        None | Some("predicate") => "predicate",
        Some("direct") => "direct",
        Some(other) => return Err(ReinError::Message(format!("未知的抢课模式：{other}"))),
    };
    let id = {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        grab::insert_intent(
            &conn,
            account.id,
            turn_id.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            turn_name.as_deref().filter(|s| !s.trim().is_empty()),
            &query,
            mode,
            spread.unwrap_or(false),
        )?
    };
    // 叫醒引擎：能解析的话立刻就解析（窗口已经开着时，用户按下就该看到志愿排好）
    grab.notify();

    let conn = state.db.lock().unwrap();
    grab::load_intent(&conn, id)?
        .ok_or_else(|| ReinError::Message("计划写入后读不回来，请重试".into()))
}

/// 计划的动作：`remove`（移除，连它派出去的任务一起收） / `now`（立刻重新解析）。
#[tauri::command]
pub fn campus_grab_intent_action(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    intent_id: i64,
    action: String,
) -> Result<()> {
    {
        let conn = state.db.lock().unwrap();
        match action.as_str() {
            "remove" => grab::delete_intent(&conn, intent_id)?,
            "now" => grab::reset_intent(&conn, intent_id)?,
            other => return Err(ReinError::Message(format!("未知的操作：{other}"))),
        }
    }
    grab.notify();
    Ok(())
}

/// 输入预览：把一句模糊查询照**教务现在的名单**跑一遍，让人在按下「加入计划」之前
/// 就看清会抢哪些班。
///
/// 与解析共用同一个匹配器和同一份名单缓存（见 `grab::resolve_turn` /
/// `GrabHub::lessons_cached`）—— 预览里看到的顺序，就是解析后排出来的志愿序。
#[tauri::command]
pub async fn campus_grab_intent_preview(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    grab: State<'_, Arc<GrabHub>>,
    query: String,
    turn_id: Option<String>,
) -> Result<GrabPreview> {
    let query = query.trim().to_string();
    let ctx = select_context(&state.db, &hub)?;
    let brief = grab::resolve_turn(&state, &ctx, turn_id.as_deref())?.ok_or_else(|| {
        ReinError::Message("教务还没公布选课批次，等它出现后预览会自动可用".into())
    })?;

    // 名单走引擎那份缓存：几分钟内重复预览不该反复打教务
    let (lessons, _) = grab.lessons_cached(&ctx, &brief.id)?;
    let hits = matcher::match_lessons(&query, &lessons);
    // **预览必须和解析看到同一批班**：指定了老师时只列那位老师的班，
    // 否则「预览里有它、计划里没有」会让人以为哪里漏了。
    let pool = matcher::preferred(&hits);
    let matches: Vec<GrabMatch> = pool
        .iter()
        .take(PREVIEW_CAP)
        .map(matcher::to_match)
        .collect();
    // 「这句查询跨了哪几门课」和解析共用同一条规则（`matcher::ambiguous_courses`），
    // 这样不会出现「预览吓唬人、引擎照抢」或者反过来的情况。
    let ambiguous = matcher::ambiguous_courses(&query, &pool)
        .into_iter()
        .map(|(code, name)| GrabCourseRef { code, name })
        .collect();
    Ok(GrabPreview {
        turn_id: brief.id,
        turn_name: brief.name,
        total: lessons.len(),
        matched: hits.len(),
        matches,
        ambiguous,
    })
}

/// 预览一次最多回多少行。只是给人看一眼「会抢哪些班」，再多也没人读。
const PREVIEW_CAP: usize = 30;

/// 暂停全部 / 恢复全部。抢课途中学生常要临时收手（比如换了网络），
/// 逐个点太慢，所以给一对批量动作。
#[tauri::command]
pub fn campus_grab_pause_all(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<()> {
    {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        conn.execute(
            "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle' \
             WHERE account_id = ?1 AND status IN ('waiting','running')",
            rusqlite::params![account.id, GRAB_PAUSED],
        )?;
    }
    grab.notify();
    Ok(())
}

#[tauri::command]
pub fn campus_grab_resume_all(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<()> {
    {
        let conn = state.db.lock().unwrap();
        let account = require_account(&conn)?;
        conn.execute(
            "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', next_at = ?3 \
             WHERE account_id = ?1 AND status = ?4",
            rusqlite::params![
                account.id,
                GRAB_WAITING,
                Utc::now().timestamp_millis(),
                GRAB_PAUSED
            ],
        )?;
    }
    grab.notify();
    Ok(())
}

/// 读引擎节奏参数。
#[tauri::command]
pub fn campus_grab_settings_get(state: State<'_, AppState>) -> Result<GrabSettings> {
    let conn = state.db.lock().unwrap();
    grab::load_settings(&conn)
}

/// 改节奏参数。**落库前一律收口**（见 `GrabSettings::sanitized`）——
/// 界面允许用户调快，但不能调出「每 50ms 打一次教务」这种东西。
#[tauri::command]
pub fn campus_grab_settings_set(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    settings: GrabSettings,
) -> Result<GrabSettings> {
    let saved = {
        let conn = state.db.lock().unwrap();
        let s = settings.sanitized();
        grab::save_settings(&conn, &s)?;
        s
    };
    grab.notify();
    Ok(saved)
}

/* ─────────────────────────── 救援面（AI 的最后补救） ───────────────────────────
 *
 * 与抢课引擎的分工：引擎管「一切照常」——窗口到了就开火、满员就守着、会话掉了自己重登；
 * 这一片管「不照常」——教务改了接口、换了返回信封、多了个没见过的报错、批次规则变了。
 * 那种时刻唯一能救回来的动作是：**带会话打一条任意请求，然后看清它到底回了什么**。
 *
 * 三条不可让步的规矩（都能说清为什么）：
 * 1. **凭据只去同源**（`rescue::check_target`）：上游是模型的输出，而模型的输入里混着远程响应 ——
 *    「把 Cookie 发到这个地址」这种注入必须从一开始就不可能成立。
 * 2. **任意公网可打，但不带任何凭据**：教务改接口时要去读它自己的 SPA 包、去核公开文档，
 *    这条路连门户的 Origin/Referer 都不带 —— 来源信息也是信息。
 * 3. **每一步留痕**：写操作不弹确认（抢课窗口里每一次确认都是拖延），
 *    那份信任由 `campus_ai_actions` 兜底：可查、可重放、有理由。
 */

/// 快照里带多少条「AI 自己干过的事」。够看清上一轮做了什么，又不至于把上下文撑爆。
const RESCUE_RECENT: usize = 20;

/// 熔断窗口（分钟）：同一条请求在这个窗口里超过 `rescue::CIRCUIT_LIMIT` 次就拒绝。
const RESCUE_WINDOW_MIN: i64 = 1;

/// 救援请求的最终形态。渲染 curl、发请求、写审计三处都从这一份出发 ——
/// 三处各拼一遍的话，重放时对不上号只是时间问题。
#[derive(Clone)]
struct Prepared {
    spec: rescue::RequestSpec,
    same_origin: bool,
}

/// 真发一次请求。同源走 [`Session`]（Cookie + 可选选课令牌，屏蔽 302 跟随）；
/// 公网走裸 ureq agent（无凭据、无门户头，过 SSRF 白名单）。
///
/// 返回「响应 + 这一趟之后的 Cookie + 耗时」：`Set-Cookie` 可能把会话换掉了，
/// 换了就得落库 —— 否则下一次又拿旧会话去撞，白换一次。
fn send_request(
    p: &Prepared,
    base: &str,
    jar: CookieJar,
    token: Option<String>,
) -> Result<(HttpResponse, CookieJar, i64)> {
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(rescue::RESCUE_TIMEOUT_SECS);
    if p.same_origin {
        let mut session = Session::with_timeout(base, jar, timeout);
        let mut extra: Vec<(&str, &str)> = p
            .spec
            .headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        // 树维选课接口要的是**裸 JWT**（没有 Bearer 前缀），见 `course_select.rs` 的模块注释
        if let Some(t) = token.as_deref() {
            extra.push(("Authorization", t));
        }
        let content_type = content_type_of(&p.spec);
        let bytes = p.spec.body.as_ref().map(|b| b.as_bytes().to_vec());
        let resp = session.request(
            &p.spec.method,
            &p.spec.url,
            None,
            &extra,
            bytes.as_ref().map(|b| (content_type.as_str(), b.clone())),
        )?;
        let jar = session.jar().clone();
        return Ok((resp, jar, started.elapsed().as_millis() as i64));
    }

    let url = crate::modules::web::commands::validate_url(&p.spec.url)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .user_agent(super::http::USER_AGENT)
        .redirects(4)
        .build();
    let mut req = agent.request(&p.spec.method, &url);
    for (k, v) in &p.spec.headers {
        req = req.set(k, v);
    }
    let outcome = match &p.spec.body {
        Some(b) => req.send_bytes(b.as_bytes()),
        None => req.call(),
    };
    // 非 2xx 也是「拿到了响应」，要原样交给模型看 —— 救援时那条错误正文常常就是答案
    let resp = match outcome {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(ReinError::Message(format!("网络请求失败：{e}"))),
    };
    let out = super::http::read_response(resp)?;
    Ok((out, CookieJar::default(), started.elapsed().as_millis() as i64))
}

/// 正文的 Content-Type。**以请求头里的那一份为准**（模型手写的内容类型要生效），
/// 没写才回落 `application/json` —— 门口那些教务接口全是 JSON。
fn content_type_of(spec: &rescue::RequestSpec) -> String {
    spec.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "application/json".into())
}

/// 现场快照：账号 + 会话探针 + 抢课引擎整份状态 + 卡住的任务 + AI 最近干过的事。
///
/// 做成**一次调用**而不是让模型连着问五个命令：排障时它最需要的是「同时看到全部」，
/// 而分开问的代价不只是慢 —— 五次调用之间现场会变，拼出来的因果可能根本不存在。
#[tauri::command]
pub async fn campus_rescue_state(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    probe: Option<bool>,
) -> Result<RescueState> {
    let (account, snapshot, recent_actions) = {
        let conn = state.db.lock().unwrap();
        (
            load_active_account(&conn)?,
            grab::snapshot(&conn, &grab)?,
            rescue::recent(&conn, RESCUE_RECENT)?,
        )
    };

    // 探针要发网络请求：手上的东西先取全，再进闭包（DB 锁绝不能跨过网络，见文件头铁律）
    let (session_alive, session_error) = match (probe.unwrap_or(true), account.as_ref()) {
        (true, Some(acc)) => {
            let spec = acc.spec()?;
            let base = acc.base_url.clone();
            let jar = CookieJar::from_json(acc.cookies.as_deref());
            let probed = tauri::async_runtime::spawn_blocking(move || {
                let mut session = Session::new(&base, jar);
                GuetAdapter::new(spec, &mut session).probe_session()
            })
            .await;
            match probed {
                Ok(Ok(alive)) => (Some(alive), None),
                Ok(Err(e)) => (None, Some(e.to_string())),
                Err(e) => (None, Some(format!("会话探针任务失败：{e}"))),
            }
        }
        _ => (None, None),
    };

    let stuck_task_ids = rescue::stuck_tasks(&snapshot.tasks, Utc::now().timestamp_millis());
    Ok(RescueState {
        account: account.map(to_account),
        session_alive,
        session_error,
        grab: snapshot,
        stuck_task_ids,
        recent_actions,
    })
}

/// 带会话打一条任意请求 —— AI 的 curl。
///
/// `url` 可以是相对路径（拼在教务 base 后面），也可以是绝对地址。
/// 相对路径 / 同源地址默认带上教务会话；外部地址一律不带凭据（给了也拒，
/// 见本节的规矩 1：安静的降级比报错更危险，模型会以为自己拿到的是「带会话的结果」）。
#[tauri::command]
pub async fn campus_http(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    req: RescueRequest,
) -> Result<RescueResponse> {
    let reason = req.reason.trim().to_string();
    if reason.is_empty() {
        return Err(ReinError::Message(
            "reason 不能为空：这条请求想搞清楚什么？事后只有它能解释审计里那一行".into(),
        ));
    }
    let method = rescue::normalize_method(req.method.as_deref())?;

    let account = {
        let conn = state.db.lock().unwrap();
        load_active_account(&conn)?
    };
    let base = account.as_ref().map(|a| a.base_url.clone()).unwrap_or_default();
    let relative = !(req.url.trim().starts_with("http://") || req.url.trim().starts_with("https://"));
    if relative && account.is_none() {
        return Err(ReinError::Message(
            "还没有绑定教务系统账号，相对路径没有可拼的域名 —— 请先在「课表配置」里登录".into(),
        ));
    }
    let url = rescue::resolve_url(&req.url, &base)?;

    let same_origin = rescue::check_target(&url, account.as_ref().map(|a| a.base_url.as_str()))?
        == rescue::Target::SameOrigin;
    let with_token = req.with_select_token.unwrap_or(false);
    // 不写 withSession 时的默认：同源就带（「看一眼教务现在怎么说」是这个工具的主用例）
    let with_session = req.with_session.unwrap_or(same_origin);
    if !same_origin && (with_session || with_token) {
        return Err(ReinError::Message(format!(
            "带凭据的请求只能打教务自己的域名（{}），{url} 是外部地址。\
             要带会话请用相对路径（如 /student/home）；要读外部页面就别带凭据 —— \
             这条请求没有发出去，避免你以为它带着会话说的是同一件事。",
            if base.is_empty() { "未登录" } else { &base }
        )));
    }

    for (k, _) in &req.headers {
        let lower = k.trim().to_ascii_lowercase();
        if matches!(lower.as_str(), "cookie" | "authorization" | "host" | "content-length") {
            return Err(ReinError::Message(format!(
                "请求头「{k}」不允许手写：会话与令牌走 withSession / withSelectToken，\
                 长度与主机由底层决定 —— 手写会让审计与导出脚本里那条命令跟实际发出的请求对不上"
            )));
        }
    }

    let mut headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.trim().to_string(), v.clone()))
        .collect();
    // 带正文就必须有一条 Content-Type：否则教务网关多半回 415，而模型看到的只是一句
    // 「失败」——把默认值在这里补上，渲染出的 curl 里也才是完整可重放的一条命令。
    if req.body.is_some()
        && !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
    {
        headers.push((
            "Content-Type".into(),
            req.content_type
                .clone()
                .unwrap_or_else(|| "application/json".into()),
        ));
    }

    let prepared = Prepared {
        spec: rescue::RequestSpec {
            method,
            url: url.clone(),
            headers,
            body: req.body.clone(),
            with_cookie: with_session,
            with_token,
        },
        same_origin,
    };
    let fp = prepared.spec.fingerprint();
    let curl = rescue::render_curl(&prepared.spec);

    // 熔断：救援工具自己不能变成新的故障（模型在一个错误上原地转圈是它最典型的失败模式）
    {
        let conn = state.db.lock().unwrap();
        let since = (Utc::now() - Duration::minutes(RESCUE_WINDOW_MIN)).to_rfc3339();
        if rescue::circuit_broken(&conn, &fp, &since)? {
            return Err(ReinError::Message(format!(
                "熔断：同一条请求（{} {}）在 {RESCUE_WINDOW_MIN} 分钟内已经打过 {} 次。\
                 停手 —— 重复同一条请求不会得到不同的答案，换个判断依据（先 campus_status 看现场）。",
                prepared.spec.method,
                url,
                rescue::CIRCUIT_LIMIT
            )));
        }
    }

    let mut token = if with_token {
        Some(select_context(&state.db, &hub)?.client.token().to_string())
    } else {
        None
    };
    let jar = account
        .as_ref()
        .map(|a| CookieJar::from_json(a.cookies.as_deref()))
        .unwrap_or_default();

    let first = {
        let p = prepared.clone();
        let base = base.clone();
        let t = token.clone();
        tauri::async_runtime::spawn_blocking(move || send_request(&p, &base, jar, t))
            .await
            .map_err(|e| ReinError::Message(format!("救援请求任务失败：{e}")))??
    };
    let (mut resp, mut jar_after, mut elapsed_ms) = first;

    // 会话失效（门户 302 回登录页 / 选课接口 401）：自愈一次再打。
    // 这正是救援面最常遇到的现场 —— 用户之所以来找 AI，十有八九就是会话怎么都救不回来。
    let lost = resp.status == 302 || (with_token && resp.status == 401);
    let mut healed = false;
    if same_origin && lost && account.is_some() {
        let acc = account.as_ref().unwrap();
        recover_session(&state.db, &hub, acc)?;
        let fresh = {
            let conn = state.db.lock().unwrap();
            require_account(&conn)?
        };
        if with_token {
            token = Some(select_context(&state.db, &hub)?.client.token().to_string());
        }
        let retried = {
            let p = prepared.clone();
            let b = fresh.base_url.clone();
            let j = CookieJar::from_json(fresh.cookies.as_deref());
            let t = token.clone();
            tauri::async_runtime::spawn_blocking(move || send_request(&p, &b, j, t))
                .await
                .map_err(|e| ReinError::Message(format!("救援请求任务失败：{e}")))??
        };
        resp = retried.0;
        jar_after = retried.1;
        elapsed_ms = retried.2;
        healed = true;
    }

    // 会话可能在响应里被换掉了（`Set-Cookie`）：立刻落库，否则下一次又拿旧的去撞
    if same_origin {
        if let Some(acc) = account.as_ref() {
            let stored = CookieJar::from_json(acc.cookies.as_deref());
            if jar_after.to_json() != stored.to_json() {
                let conn = state.db.lock().unwrap();
                persist_session(&conn, acc.id, &jar_after)?;
            }
        }
    }

    let (body, truncated, bytes) = rescue::truncate(&resp.body, rescue::clamp_max_bytes(req.max_bytes));
    let ok = resp.is_ok();
    let note = if healed {
        Some("会话已失效，已自动重新登录并重试了一次 —— 上面是重试后的响应".to_string())
    } else if !same_origin {
        Some("外部地址：这条请求没有携带任何教务凭据".to_string())
    } else {
        None
    };
    let summary = format!(
        "{} {} → HTTP {}{}",
        prepared.spec.method,
        prepared.spec.url,
        resp.status,
        if healed { "（会话已自动重登）" } else { "" }
    );

    {
        let conn = state.db.lock().unwrap();
        rescue::record(
            &conn,
            &now_iso(),
            rescue::Audit {
                kind: rescue::KIND_HTTP,
                summary: &summary,
                detail: Some(&serde_json::json!({
                    "reason": reason,
                    "url": prepared.spec.url,
                    "method": prepared.spec.method,
                    "status": resp.status,
                    "bytes": bytes,
                    "truncated": truncated,
                    "sameOrigin": same_origin,
                    "healed": healed,
                })),
                curl: Some(&curl),
                fp: Some(&fp),
                status: if ok { rescue::STATUS_OK } else { rescue::STATUS_ERROR },
                account_id: account.as_ref().map(|a| a.id),
            },
        )?;
        let _ = rescue::prune(&conn);
    }

    Ok(RescueResponse {
        url: prepared.spec.url,
        method: prepared.spec.method,
        status: resp.status,
        ok,
        same_origin,
        with_session: prepared.spec.with_cookie,
        with_select_token: prepared.spec.with_token,
        headers: resp.headers,
        body,
        truncated,
        bytes,
        elapsed_ms,
        curl,
        healed,
        note,
    })
}

/// 把一次**不带请求**的动作写进审计（加任务、重试、改节奏、退课……）。
///
/// 为什么这些也要记：出事以后人问的第一个问题永远是「AI 都干了什么」。
/// 只有请求记录的话，答案会是「它打过 12 条请求」——那是过程，不是结果。
#[tauri::command]
pub fn campus_rescue_note(
    state: State<'_, AppState>,
    kind: String,
    summary: String,
    detail: Option<serde_json::Value>,
) -> Result<i64> {
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err(ReinError::Message("summary 不能为空".into()));
    }
    let kind = rescue::normalize_kind(&kind)?;
    let conn = state.db.lock().unwrap();
    let account_id = load_active_account(&conn)?.map(|a| a.id);
    let id = rescue::record(
        &conn,
        &now_iso(),
        rescue::Audit {
            kind,
            summary: &summary,
            detail: detail.as_ref(),
            curl: None,
            fp: None,
            status: rescue::STATUS_OK,
            account_id,
        },
    )?;
    let _ = rescue::prune(&conn);
    Ok(id)
}

/// 导出救援脚本：把这段时间里打过的请求渲染成一份能脱离 App 运行的 `.sh`。
///
/// 为什么要落盘而不是把文本回给模型：**会话是会过期的**。这份脚本的用法是
/// 「AI 现在把路趟通 → 人过一会儿/换个网络/在另一台机器上照着再走一遍」，
/// 那时 App 可能已经不在了，而脚本里带着当时那份凭据快照。
#[tauri::command]
pub fn campus_curl_export(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    hours: Option<i64>,
    limit: Option<usize>,
) -> Result<CurlExport> {
    let hours = hours.unwrap_or(6).clamp(1, 24 * 7);
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let since = (Utc::now() - Duration::hours(hours)).to_rfc3339();

    let (entries, account, token) = {
        let conn = state.db.lock().unwrap();
        let entries = rescue::scriptable_since(&conn, &since, limit)?;
        let account = load_active_account(&conn)?;
        // 令牌缓存在进程内（见 state.rs）：换过进程就没了，脚本里那只说明「现在拿不到」
        let token = account.as_ref().and_then(|a| hub.cached_select_token(a.id));
        (entries, account, token)
    };
    if entries.is_empty() {
        return Err(ReinError::Message(format!(
            "最近 {hours} 小时里没有可导出的请求（{since} 之后）。先在 App 里打几条真实请求再导出。"
        )));
    }

    let base = account.as_ref().map(|a| a.base_url.clone()).unwrap_or_default();
    let cookie = account
        .as_ref()
        .and_then(|a| CookieJar::from_json(a.cookies.as_deref()).header());
    let generated_at = now_iso();
    let script = rescue::render_script(
        &entries,
        &rescue::ScriptEnv {
            base: &base,
            cookie: cookie.as_deref(),
            select_token: token.as_deref(),
            generated_at: &generated_at,
        },
    );

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ReinError::Message(format!("无法定位应用数据目录：{e}")))?
        .join("rescue");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("rescue-{}.sh", Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, script.as_bytes())?;

    {
        let conn = state.db.lock().unwrap();
        rescue::record(
            &conn,
            &generated_at,
            rescue::Audit {
                kind: rescue::KIND_SCRIPT,
                summary: &format!(
                    "导出救援脚本：{} 条请求 → {}",
                    entries.len(),
                    path.display()
                ),
                detail: None,
                curl: None,
                fp: None,
                status: rescue::STATUS_OK,
                account_id: account.as_ref().map(|a| a.id),
            },
        )?;
        let _ = rescue::prune(&conn);
    }

    Ok(CurlExport {
        path: path.to_string_lossy().to_string(),
        script,
        count: entries.len(),
        generated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;

    fn sem(start: &str, week_start_on_sunday: bool) -> CampusSemester {
        CampusSemester {
            id: 1,
            account_id: 1,
            remote_id: 321,
            code: Some("2026-2027_1".into()),
            name: "2026-2027 第一学期".into(),
            school_year: Some("2026-2027".into()),
            season: Some("AUTUMN".into()),
            start_date: start.into(),
            end_date: "2027-01-24".into(),
            week_start_on_sunday,
            total_weeks: 19,
            current_week: Some(1),
            is_current: true,
        }
    }

    /// 会话过期的判据必须与教务实际吐出的文案对齐 —— 判错一次，
    /// 用户看到的就是「明明存了密码，还要手动重新登录」。
    #[test]
    fn session_loss_is_recognised_by_the_strings_the_system_actually_emits() {
        for msg in [
            "获取课表页面 需要登录：会话已过期，请重新登录教务系统",
            "教务会话已过期，无法获取选课令牌，请先在「课表配置」重新登录",
            "登录状态已过期，且该账号没有保存密码 —— 请到「课表配置」重新登录一次",
            "登录已过期",
        ] {
            assert!(is_session_lost(&ReinError::Message(msg.into())), "{msg}");
        }
        // 普通失败不能被误判成会话过期，否则每次失败都要白重登一遍
        for msg in [
            "获取课表数据失败：HTTP 503",
            "课表数据为空：该学期可能没有排课",
            "网络请求失败：timed out",
        ] {
            assert!(!is_session_lost(&ReinError::Message(msg.into())), "{msg}");
        }
    }

    /// 没存密码时自愈必须**明确拒绝**并说清怎么补救（勾上保存密码以后就不用再管了），
    /// 而不是拿一句「登录失败」把用户堵在那里。
    #[test]
    fn relogin_without_a_saved_password_says_what_to_do() {
        let account = AccountRow {
            id: 1,
            system_kind: "guet-supwisdom-eams5".into(),
            base_url: "https://bkjwtest.guet.edu.cn".into(),
            login_name: "2600350118".into(),
            password: None,
            cookies: None,
            session_at: None,
            student_id: None,
            student_code: None,
            student_name: None,
            department: None,
            major: None,
            adminclass: None,
            grade: None,
            total_credits: None,
            save_password: false,
            active: true,
            last_sync_at: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        // 没有密码就不该发任何请求：直接给出可照做的提示
        let err = relogin(&account).unwrap_err();
        assert!(err.to_string().contains("保存密码"), "{err}");
        assert!(is_session_lost(&err), "这类失败仍属于「会话过期」家族：{err}");
    }

    #[test]
    fn occurrence_dates_match_calendar() {
        let anchor = guet::parse_ymd("2026-09-14").unwrap();
        // 第 1 教学周周一 = 学期起始日
        assert_eq!(
            occurrence_date(anchor, 1, 1, false).unwrap().to_string(),
            "2026-09-14"
        );
        // 第 1 教学周周日 = 09-20
        assert_eq!(
            occurrence_date(anchor, 1, 7, false).unwrap().to_string(),
            "2026-09-20"
        );
        // 实测样本：大学生心理健康教育，第 3~12 周、星期五 8-9 节 → 第 3 周周五 = 10-02
        assert_eq!(
            occurrence_date(anchor, 3, 5, false).unwrap().to_string(),
            "2026-10-02"
        );
        // 越界一律 None，不 panic
        assert!(occurrence_date(anchor, 0, 1, false).is_none());
        assert!(occurrence_date(anchor, 1, 8, false).is_none());
    }

    #[test]
    fn occurrence_dates_sunday_first_week() {
        let anchor = guet::parse_ymd("2026-09-13").unwrap(); // 周日
        assert_eq!(
            occurrence_date(anchor, 1, 7, true).unwrap().to_string(),
            "2026-09-13"
        );
        assert_eq!(
            occurrence_date(anchor, 1, 1, true).unwrap().to_string(),
            "2026-09-14"
        );
    }

    #[test]
    fn expands_session_into_one_entry_per_week() {
        let sessions = vec![CampusSession {
            id: 7,
            course_id: 1,
            weekday: 5,
            start_unit: 8,
            end_unit: 9,
            start_time: "16:30".into(),
            end_time: "18:05".into(),
            weeks: vec![3, 4, 5],
            weeks_str: Some("3~5".into()),
            room: Some("16407*".into()),
            building: Some("花江校区第十六教学楼".into()),
            campus: Some("花江校区".into()),
            course_name: "大学生心理健康教育".into(),
            course_code: Some("000003".into()),
            teachers: vec!["范志燕".into()],
            credits: Some(2.0),
            course_type: Some("通识必修".into()),
            color: None,
        }];
        let entries = expand_entries(&sem("2026-09-14", false), &sessions);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].date, "2026-10-02");
        assert_eq!(entries[0].week, 3);
        assert_eq!(entries[2].date, "2026-10-16");
    }

    #[test]
    fn time_slots_are_deduped_and_sorted() {
        let mk = |su: i64, eu: i64, st: &str, et: &str| CampusSession {
            id: su,
            course_id: 1,
            weekday: 1,
            start_unit: su,
            end_unit: eu,
            start_time: st.into(),
            end_time: et.into(),
            weeks: vec![1],
            weeks_str: None,
            room: None,
            building: None,
            campus: None,
            course_name: "c".into(),
            course_code: None,
            teachers: vec![],
            credits: None,
            course_type: None,
            color: None,
        };
        let sessions = vec![
            mk(3, 4, "09:55", "11:30"),
            mk(1, 2, "08:00", "09:35"),
            mk(3, 4, "09:55", "11:30"), // 重复
        ];
        let slots = build_time_slots(&sessions);
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].start_time, "08:00");
        assert_eq!(slots[0].start_min, 480);
        assert_eq!(slots[1].duration_min, 95);
    }

    #[test]
    fn class_notes_compose_readable_line() {
        let s = CampusSession {
            id: 1,
            course_id: 1,
            weekday: 1,
            start_unit: 8,
            end_unit: 9,
            start_time: "16:30".into(),
            end_time: "18:05".into(),
            weeks: vec![1],
            weeks_str: None,
            room: Some("16407*".into()),
            building: Some("十六教学楼".into()),
            campus: None,
            course_name: "c".into(),
            course_code: None,
            teachers: vec!["范志燕".into(), "张三".into()],
            credits: None,
            course_type: None,
            color: None,
        };
        assert_eq!(
            class_notes(&s).unwrap(),
            "第8-9节 · 十六教学楼 16407* · 范志燕、张三"
        );
        assert_eq!(class_notes(&s).unwrap().is_empty(), false);
    }

    #[test]
    fn semester_anchor_snaps_midweek_start() {
        // 就算教务给了个周三，锚点也会吸附到那一周的周一
        let s = sem("2026-09-16", false);
        assert_eq!(semester_anchor(&s).unwrap().to_string(), "2026-09-14");
    }

    /// 物化是全链路里最容易错的 SQL（先删后建 + 跳过已打卡 + 窗口裁剪），
    /// 用一个真迁移出来的内存库把它钉住。
    fn seed_account(conn: &Connection) -> CampusSemester {
        let today = Local::now().date_naive();
        let guet_weekday = today.weekday().num_days_from_monday() as i64 + 1;
        let now = now_iso();
        conn.execute(
            "INSERT INTO campus_accounts (id, system_kind, base_url, login_name, created_at, updated_at) \
             VALUES (1, 'guet-supwisdom-eams5', 'https://x', '2600', ?1, ?1)",
            [&now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_semesters (id, account_id, remote_id, name, start_date, end_date, \
             week_start_on_sunday, total_weeks, is_current) VALUES (1, 1, 321, '2026-2027 第一学期', ?1, ?2, 0, 19, 1)",
            rusqlite::params![
                today.format("%Y-%m-%d").to_string(),
                (today + Duration::days(140)).format("%Y-%m-%d").to_string(),
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_courses (id, account_id, semester_id, remote_lesson_id, course_name) \
             VALUES (1, 1, 1, 900, '高等数学')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_sessions (id, account_id, semester_id, course_id, weekday, start_unit, \
             end_unit, start_time, end_time, weeks, weeks_str) VALUES (1, 1, 1, 1, ?1, 1, 2, '08:00', '09:35', ?2, '1~6')",
            rusqlite::params![
                guet_weekday,
                serde_json::to_string(&vec![1, 2, 3, 4, 5, 6, 20]).unwrap(),
            ],
        )
        .unwrap();
        load_semester(conn, 1, 1).unwrap()
    }

    #[test]
    fn materialize_is_idempotent_and_preserves_done_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        let sessions = load_sessions(&conn, 1, 1).unwrap();

        let count_todos = |c: &Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
                .unwrap()
        };

        // 学期起始日 = 今天，星期取今天 → 第 1 周就是今天；第 20 周落在窗口外
        let first = materialize_todos(&conn, 1, &sem, &sessions).unwrap();
        assert_eq!(first, 6, "只物化窗口内的 6 周，第 20 周必须被裁掉");
        assert_eq!(count_todos(&conn), 6);

        // 幂等：重复执行不累积
        let second = materialize_todos(&conn, 1, &sem, &sessions).unwrap();
        assert_eq!(second, 6);
        assert_eq!(count_todos(&conn), 6, "先删后建，不该越跑越多");

        // 打卡一次 → 重建后它原样保留，且不会被重新创建成未完成态
        let done_id: i64 = conn
            .query_row("SELECT id FROM todos ORDER BY date LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute("UPDATE todos SET status = 'done' WHERE id = ?1", [done_id])
            .unwrap();

        let third = materialize_todos(&conn, 1, &sem, &sessions).unwrap();
        assert_eq!(third, 5, "已打卡的那一次不再重建");
        assert_eq!(count_todos(&conn), 6, "历史行 + 5 条未完成");
        let kept: String = conn
            .query_row("SELECT status FROM todos WHERE id = ?1", [done_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "done", "done 行带着原 id 保留下来");

        // 派生行的形状：分类、来源、时间口径
        let (cat, sid, sm, dur, title): (String, Option<i64>, Option<i64>, Option<i64>, String) =
            conn.query_row(
                "SELECT category, course_session_id, start_min, duration_min, title FROM todos \
                 WHERE status != 'done' LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(cat, "class");
        assert_eq!(sid, Some(1));
        assert_eq!(sm, Some(480)); // 08:00
        assert_eq!(dur, Some(95)); // 08:00→09:35
        assert_eq!(title, "高等数学");
    }

    /// 退课/换课后：远端消失的时段被清掉，但已经打过卡的历史行**不能被牵连删除**。
    /// 这正是外键 + 「done 行永不删」两条约束的交叉点，之前就是在这里炸的。
    #[test]
    fn stale_sessions_are_removed_without_losing_history() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        let sessions = load_sessions(&conn, 1, 1).unwrap();
        materialize_todos(&conn, 1, &sem, &sessions).unwrap();

        let done_id: i64 = conn
            .query_row("SELECT id FROM todos ORDER BY date LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute("UPDATE todos SET status = 'done' WHERE id = ?1", [done_id])
            .unwrap();

        // 该时段从远端消失；本次同步没有任何存活时段
        let removed = delete_stale_sessions(&conn, 1, 1, &[]).unwrap();
        assert_eq!(removed, 1);

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "历史打卡行必须活下来");
        let (status, link): (String, Option<i64>) = conn
            .query_row(
                "SELECT status, course_session_id FROM todos",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "done");
        assert_eq!(link, None, "来源链接被摘掉，但行本身保留");

        let sessions_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM campus_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions_left, 0);

        // 未完成的派生行随后由物化清空
        let written = materialize_todos(&conn, 1, &sem, &[]).unwrap();
        assert_eq!(written, 0);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
    }

    /// 注销 ≠ 删数据：会话清掉，但课表快照与整条时间线原样保留（转为只读快照）。
    #[test]
    fn logout_keeps_schedule_and_timeline() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        conn.execute(
            "UPDATE campus_accounts SET cookies = '[]', session_at = '2026-01-01T00:00:00' WHERE id = 1",
            [],
        )
        .unwrap();
        materialize_todos(&conn, 1, &sem, &load_sessions(&conn, 1, 1).unwrap()).unwrap();

        clear_session(&conn, 1).unwrap();

        let (cookies, at): (Option<String>, Option<String>) = conn
            .query_row("SELECT cookies, session_at FROM campus_accounts WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(cookies.is_none(), "会话必须清掉");
        assert!(at.is_none(), "会话时间必须清掉");

        let account_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM campus_accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(account_left, 1, "账号本身保留 —— 注销不是删账号");

        let (sessions, todos_left): (i64, i64) = (
            conn.query_row("SELECT COUNT(*) FROM campus_sessions", [], |r| r.get(0))
                .unwrap(),
            conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
                .unwrap(),
        );
        assert_eq!(sessions, 1, "课表快照保留");
        assert_eq!(todos_left, 6, "时间线保留为只读快照");
    }

    /// 删账号 = 彻底移除：派生行必须显式删（todos 未开外键级联），课表由 FK 级联带走。
    #[test]
    fn deleting_account_removes_timeline_and_schedule() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        materialize_todos(&conn, 1, &sem, &load_sessions(&conn, 1, 1).unwrap()).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            6
        );

        delete_account_data(&conn, 1).unwrap();

        for (table, label) in [
            ("campus_accounts", "账号"),
            ("campus_semesters", "学期"),
            ("campus_courses", "课程"),
            ("campus_sessions", "时段"),
            ("todos", "派生日程"),
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{label} 表应当被清空");
        }
        // 非课表来源的待办不能被牵连——这条靠 SQL 的作用域保证，钉住它
        conn.execute(
            "INSERT INTO todos (title, category, priority, status, created_at) \
             VALUES ('自己的事情', 'general', 0, 'todo', '2026-01-01T00:00:00')",
            [],
        )
        .unwrap();
        delete_account_data(&conn, 1).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "与课表无关的待办不许被删");
    }

    /// 切学期：只清「非当前学期」的**未完成**派生行，已打卡的历史与新学期的行都不许动。
    #[test]
    fn switching_semester_clears_only_other_semesters_open_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        // 第一学期（旧）：物化出一批未完成派生行
        materialize_todos(&conn, 1, &sem, &load_sessions(&conn, 1, 1).unwrap()).unwrap();

        // 第二学期（新）+ 一条属于它的时段与派生行（模拟刚同步完的当前学期）
        conn.execute(
            "INSERT INTO campus_semesters (id, account_id, remote_id, name, start_date, end_date, \
             week_start_on_sunday, total_weeks, is_current) \
             VALUES (2, 1, 322, '2026-2027 第二学期', '2027-02-22', '2027-07-04', 0, 19, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_sessions (id, account_id, semester_id, course_id, weekday, start_unit, \
             end_unit, start_time, end_time, weeks, weeks_str) \
             VALUES (2, 1, 2, 1, 1, 1, 2, '08:00', '09:35', '[1]', '1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO todos (title, category, priority, status, created_at, course_session_id, date) \
             VALUES ('新学期的课', 'class', 0, 'todo', '2026-01-01T00:00:00', 2, ?1)",
            [Local::now().date_naive().format("%Y-%m-%d").to_string()],
        )
        .unwrap();

        // 旧学期里挑一条打成 done，验证历史不被牵连
        let done_id: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE course_session_id = 1 ORDER BY date LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute("UPDATE todos SET status = 'done' WHERE id = ?1", [done_id])
            .unwrap();

        switch_semester(&conn, 1, 2).unwrap();

        let old_open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM todos WHERE course_session_id = 1 AND status != 'done'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_open, 0, "旧学期没打勾的派生行要清掉，否则与新学期的课叠在一起");

        let done_kept: String = conn
            .query_row("SELECT status FROM todos WHERE id = ?1", [done_id], |r| r.get(0))
            .unwrap();
        assert_eq!(done_kept, "done", "打过的卡是历史，切学期不许动它");

        let new_kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos WHERE course_session_id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new_kept, 1, "新学期的行不属于「非当前学期」，不能被误删");

        let current: i64 = conn
            .query_row("SELECT id FROM campus_semesters WHERE is_current = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(current, 2, "当前学期标记要跟着切");
        let flags: i64 = conn
            .query_row("SELECT COUNT(*) FROM campus_semesters WHERE is_current = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(flags, 1, "同一时刻只能有一个当前学期");
    }

    /// 没有可删的时段时直接返回，不做无谓的写
    #[test]
    fn delete_stale_is_noop_when_nothing_disappeared() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_account(&conn);
        assert_eq!(delete_stale_sessions(&conn, 1, 1, &[1]).unwrap(), 0);
        assert_eq!(delete_stale_sessions(&conn, 1, 99, &[]).unwrap(), 0);
    }
}
