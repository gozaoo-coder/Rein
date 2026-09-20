//! 学校系统选择器（抽象层）。
//!
//! 把「哪一所学校的教务系统、用哪套登录握手、打哪些接口」声明成**数据**而不是散落的 if/else。
//! 新增一所学校 = 在 [`REGISTRY`] 末尾加一条 [`SchoolSystemSpec`]：
//! 前端的选择器自动多出一个选项，登录表单按 [`LoginStrategy`] 自动渲染出对应字段，
//! 抓取流程按 [`EndpointSpec`] 自动走——三处都不用改。
//!
//! 与 `modules/voice` 的 ASR 适配器同思路（`AnyAsrAdapter` + `AsrAdapterKind::detect`），
//! 区别是那边的差异在**协议**（WS 帧格式、鉴权头），这边的差异在**站点与登录握手**。

use serde::Serialize;

/// 登录握手策略：一套固定的「取 salt → 混淆口令 → 提交 → 建会话」流程。
#[derive(Debug, Clone, Copy)]
pub enum LoginStrategy {
    /// 树维（Supwisdom）EAMS 门户：`/student/ldap/login`。
    ///
    /// `GET salt` → `RSA_PKCS1_v1_5(salt + "-" + password)` → `POST JSON` → **Cookie 会话**
    /// （不是 token；后续请求靠 `__pstsid__` / `SESSION` 两个 Cookie 认人）。
    SupwisdomPortalRsa {
        /// PKCS#8 SPKI DER 的 base64。这是登录页静态 JS 里公开硬编码的值，不是机密。
        public_key: &'static str,
        salt_path: &'static str,
        login_path: &'static str,
        captcha_path: &'static str,
        /// 会话探针：200 = 仍有效，302 = 已过期
        probe_path: &'static str,
    },
}

impl LoginStrategy {
    /// 稳定标识，仅用于日志与诊断。
    pub fn id(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { .. } => "supwisdom-portal-rsa",
        }
    }

    /// 取 salt 的路径（不含 query）。
    pub fn salt_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { salt_path, .. } => salt_path,
        }
    }

    pub fn login_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { login_path, .. } => login_path,
        }
    }

    pub fn captcha_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { captcha_path, .. } => captcha_path,
        }
    }

    pub fn probe_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { probe_path, .. } => probe_path,
        }
    }

    pub fn public_key(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { public_key, .. } => public_key,
        }
    }
}

/// 该学校系统的接口表。`{sem}` / `{std}` 是占位符，由下面的方法展开。
#[derive(Debug, Clone, Copy)]
pub struct EndpointSpec {
    /// 课表页面：**学期列表的唯一来源**（树维没有独立的 semester-list API）
    pub course_table_page: &'static str,
    /// 课表数据（主数据源，路径里只有 semesterId，最稳）
    pub course_table_print: &'static str,
    /// 培养方案（响应体很大，按需拉取 + 落缓存）
    pub program_info: &'static str,
}

impl EndpointSpec {
    /// `/student/for-std/course-table?bizTypeId=2`
    pub fn course_table_page_for(&self, biz_type_id: i64) -> String {
        format!("{}?bizTypeId={biz_type_id}", self.course_table_page)
    }

    /// `/student/for-std/course-table/semester/321/print-data?semesterId=321&hasExperiment=true`
    pub fn course_table_print_for(&self, semester_id: i64) -> String {
        let path = self
            .course_table_print
            .replace("{sem}", &semester_id.to_string());
        format!("{path}?semesterId={semester_id}&hasExperiment=true")
    }

    /// `/student/for-std/program/program-info-json?studentId=241250`
    pub fn program_info_for(&self, student_id: &str) -> String {
        format!("{}?studentId={student_id}", self.program_info)
    }
}

/// 学期口径。
#[derive(Debug, Clone, Copy)]
pub struct TermSpec {
    /// 培养层次：1=研究生 2=本科生（决定课表页面的默认查询范围）
    pub biz_type_id: i64,
    /// 教务的「一周」从周日还是周一算起。决定周次 → 公历日期的偏移公式。
    pub week_start_on_sunday: bool,
}

/// 一所学校系统的完整声明。
#[derive(Debug, Clone, Copy)]
pub struct SchoolSystemSpec {
    /// 稳定键，落库在 `campus_accounts.system_kind`
    pub kind: &'static str,
    /// 选择器里显示的名字
    pub name: &'static str,
    /// 摘要入口用的一行短名（`name` 带产品线后缀，太长）
    pub short_name: &'static str,
    /// 显示用的厂商/产品线，帮用户确认自己学校是不是这一套
    pub vendor: &'static str,
    pub default_base_url: &'static str,
    pub login: LoginStrategy,
    pub endpoints: EndpointSpec,
    pub term: TermSpec,
}

/// 前端选择器用的投影（`campus_systems` 命令的返回项）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchoolSystemInfo {
    pub kind: &'static str,
    pub name: &'static str,
    pub short_name: &'static str,
    pub vendor: &'static str,
    pub default_base_url: &'static str,
    /// 登录握手标识（"supwisdom-portal-rsa"），前端据此决定表单文案与字段
    pub login_strategy: &'static str,
    pub biz_type_id: i64,
    /// 登录过程中可能出现图形验证码，需要 UI 预留验证码输入位
    pub may_require_captcha: bool,
}

/// 桂林电子科技大学 · 本科生教学信息平台学生端。
///
/// 实测（2026-09，bkjwtest）：
/// - 门户入口链路是 `v.guet.edu.cn` → `pcportal.guet.edu.cn/sopplus`，**但直连
///   `/student/ldap/login` 用同一套学号密码即可登录**，无需走门户——这正是免浏览器自动化的前提。
/// - 密码区分大小写且**不做任何 trim**：实测用户口令结尾的句点也是密码的一部分。
///   （口令本身不写进源码 —— 联调需要时用 `REIN_GUET_USER` / `REIN_GUET_PASS` 环境变量，
///   见 `guet.rs` 与 `course_select.rs` 里的 `#[ignore]` 实测用例。）
const GUET: SchoolSystemSpec = SchoolSystemSpec {
    kind: "guet-supwisdom-eams5",
    name: "桂林电子科技大学 · 本科生教学信息平台",
    short_name: "桂林电子科技大学",
    vendor: "树维 Supwisdom EAMS5 · 学生端",
    default_base_url: "https://bkjwtest.guet.edu.cn",
    login: LoginStrategy::SupwisdomPortalRsa {
        public_key: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCFY5N+9UX+0BF+xz1svFguI4CIDvmQTfINkOZ1HOO3ltBNHGQTUirUPQTyEph/+q/l8b16YYw3I2fyTH6y15s3tHf5jMei+R/20jFRGo5udwVJUwq/RozKQIRzCtPYkXG4YWBnHKhXalZ5K2fhd5i/QtB016nVugH/7eiBDWbKVwIDAQAB",
        salt_path: "/student/ldap/login-salt",
        login_path: "/student/ldap/login",
        captcha_path: "/student/ldap/login-captcha",
        probe_path: "/student/home",
    },
    endpoints: EndpointSpec {
        course_table_page: "/student/for-std/course-table",
        course_table_print: "/student/for-std/course-table/semester/{sem}/print-data",
        program_info: "/student/for-std/program/program-info-json",
    },
    term: TermSpec {
        biz_type_id: 2,
        week_start_on_sunday: false,
    },
};

const REGISTRY: &[SchoolSystemSpec] = &[GUET];

pub fn spec(kind: &str) -> Option<&'static SchoolSystemSpec> {
    REGISTRY.iter().find(|s| s.kind == kind)
}

pub fn list_info() -> Vec<SchoolSystemInfo> {
    REGISTRY
        .iter()
        .map(|s| SchoolSystemInfo {
            kind: s.kind,
            name: s.name,
            short_name: s.short_name,
            vendor: s.vendor,
            default_base_url: s.default_base_url,
            login_strategy: s.login.id(),
            biz_type_id: s.term.biz_type_id,
            may_require_captcha: true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lookup_roundtrip() {
        assert_eq!(list_info().len(), 1);
        let guet = spec("guet-supwisdom-eams5").expect("桂电必须在册");
        assert!(spec("nope").is_none());
        assert_eq!(guet.term.biz_type_id, 2);
        assert_eq!(list_info()[0].login_strategy, "supwisdom-portal-rsa");
        // 摘要入口只显示短名；短名必须是不带产品线后缀的可读校名
        assert_eq!(guet.short_name, "桂林电子科技大学");
        assert_eq!(list_info()[0].short_name, guet.short_name);
    }

    #[test]
    fn endpoint_templates_expand() {
        let e = GUET.endpoints;
        assert_eq!(
            e.course_table_page_for(2),
            "/student/for-std/course-table?bizTypeId=2"
        );
        assert_eq!(
            e.course_table_print_for(321),
            "/student/for-std/course-table/semester/321/print-data?semesterId=321&hasExperiment=true"
        );
        assert_eq!(
            e.program_info_for("241250"),
            "/student/for-std/program/program-info-json?studentId=241250"
        );
    }
}
