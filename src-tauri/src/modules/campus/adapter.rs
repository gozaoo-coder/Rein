//! 适配器分派：按学校声明的登录策略，把调用转给对应的厂商适配器。
//!
//! 为什么要有这一层：在第二家厂商进来之前，`commands.rs` 里有 8 处直接
//! `GuetAdapter::new(spec, session)`。再多一家，那些地方每一处都要按学校分叉 ——
//! 那等于把「哪所学校用哪套协议」这个知识从 [`super::provider`] 抄到了命令层，
//! 而它正是 provider 存在的理由。这里收口成一处：命令层只说
//! 「登录 / 拿学期 / 拿课表」，谁来干由本模块决定。

use crate::error::Result;

use super::guet::GuetAdapter;
use super::http::Session;
use super::models::{LoginOutcome, PageVars, TimetableSnapshot};
use super::provider::{LoginStrategy, SchoolSystemSpec};
use super::zfsoft::ZfsoftAdapter;

pub enum AnyAdapter<'a> {
    Guet(GuetAdapter<'a>),
    Zfsoft(ZfsoftAdapter<'a>),
}

impl<'a> AnyAdapter<'a> {
    /// 按 spec 声明的登录策略挑适配器。
    ///
    /// **认不出来就编译期报错**（match 覆盖了 [`LoginStrategy`] 的全部变体）——
    /// 这正是把策略做成 enum 而不是字符串的原因：新增一家厂商时，
    /// 忘记接上分派会在编译时被抓住，而不是在用户点登录时才发现。
    pub fn new(spec: &'static SchoolSystemSpec, session: &'a mut Session) -> Self {
        match spec.login {
            LoginStrategy::SupwisdomPortalRsa { .. } => {
                Self::Guet(GuetAdapter::new(spec, session))
            }
            LoginStrategy::ZfsoftLoginRsa { .. } => {
                Self::Zfsoft(ZfsoftAdapter::new(spec, session))
            }
        }
    }

    /// 取验证码前的会话预热（树维要把会话建起来，正方不用）。
    pub fn warm_login_session(&mut self) -> Result<()> {
        match self {
            Self::Guet(a) => a.warm_login_session(),
            Self::Zfsoft(a) => a.warm_login_session(),
        }
    }

    /// 会话探针：200 = 仍有效，302 = 被踢回登录页。
    pub fn probe_session(&mut self) -> Result<bool> {
        match self {
            Self::Guet(a) => a.probe_session(),
            Self::Zfsoft(a) => a.probe_session(),
        }
    }

    /// 取图形验证码（裸 base64）。
    pub fn fetch_captcha(&mut self) -> Result<String> {
        match self {
            Self::Guet(a) => a.fetch_captcha(),
            Self::Zfsoft(a) => a.fetch_captcha(),
        }
    }

    /// 登录握手（两家厂商的流程与判定完全不同，各自实现）。
    pub fn login(&mut self, login_name: &str, password: &str, captcha: &str) -> Result<LoginOutcome> {
        match self {
            Self::Guet(a) => a.login(login_name, password, captcha),
            Self::Zfsoft(a) => a.login(login_name, password, captcha),
        }
    }

    /// 课表页面变量（学期列表）。
    ///
    /// `wanted` 是调用方**明确要的那个远端学期**。树维的学期列表全在页面里，
    /// 用不上它；正方的学期列表要逐个补周历（起止日期），只取当前学年 ±1，
    /// 这一项保证「用户翻回三年前那个学期」也能被包含进来。
    pub fn fetch_page_vars(&mut self, wanted: Option<i64>) -> Result<PageVars> {
        match self {
            Self::Guet(a) => a.fetch_page_vars(),
            Self::Zfsoft(a) => a.fetch_page_vars(wanted),
        }
    }

    /// 课表数据（主数据源）→ 归一化快照。
    pub fn fetch_timetable(&mut self, semester_id: i64) -> Result<TimetableSnapshot> {
        match self {
            Self::Guet(a) => a.fetch_timetable(semester_id),
            Self::Zfsoft(a) => a.fetch_timetable(semester_id),
        }
    }

    /// 培养方案。只有树维那套系统有这个接口，正方会返回一句明确的「不支持」。
    pub fn fetch_program_info(&mut self, student_id: &str) -> Result<serde_json::Value> {
        match self {
            Self::Guet(a) => a.fetch_program_info(student_id),
            Self::Zfsoft(a) => a.fetch_program_info(student_id),
        }
    }
}
