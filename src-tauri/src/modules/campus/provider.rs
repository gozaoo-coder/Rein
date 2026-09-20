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
/// 实测（2026-09，bkjwtest / bkjw 同一套系统）：
/// - 门户入口链路是 `v.guet.edu.cn` → `pcportal.guet.edu.cn/sopplus`，**但直连
///   `/student/ldap/login` 用同一套学号密码即可登录**，无需走门户——这正是免浏览器自动化的前提。
/// - 密码区分大小写且**不做任何 trim**：实测用户口令结尾的句点也是密码的一部分。
///   （口令本身不写进源码 —— 联调需要时用 `REIN_GUET_USER` / `REIN_GUET_PASS` 环境变量，
///   见 `guet.rs` 与 `course_select.rs` 里的 `#[ignore]` 实测用例。）
///
/// **同一套系统有两个域名**（本科教务的正式与测试），除了域名之外一字不差：
/// - `bkjw.guet.edu.cn` —— **正式**，真正的选课就发生在这里，默认选它；
/// - `bkjwtest.guet.edu.cn` —— 测试，联调与演练用（风控更松，别拿它当生产结论）。
///
/// 所以这里声明**两份 spec 共享同一套握手与接口表**，只差 `kind` / 名字 / 域名 ——
/// 避免出现「只在测试域练过拳」而正式域第一次打就露馅。
macro_rules! guet_spec {
    ($kind:literal, $name:literal, $vendor:literal, $base:literal) => {
        SchoolSystemSpec {
            kind: $kind,
            name: $name,
            short_name: "桂林电子科技大学",
            vendor: $vendor,
            default_base_url: $base,
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
        }
    };
}

const GUET_PROD: SchoolSystemSpec = guet_spec!(
    "guet-supwisdom-eams5",
    "桂林电子科技大学 · 本科生教学信息平台（正式）",
    "树维 Supwisdom EAMS5 · 学生端 · bkjw.guet.edu.cn（正式选课在这里）",
    "https://bkjw.guet.edu.cn"
);

/// 测试域。**排在正式后面**：默认选中第一项，而默认该是正式域。
const GUET_TEST: SchoolSystemSpec = guet_spec!(
    "guet-supwisdom-eams5-test",
    "桂林电子科技大学 · 本科生教学信息平台（测试）",
    "树维 Supwisdom EAMS5 · 学生端 · bkjwtest.guet.edu.cn（联调用，风控更松）",
    "https://bkjwtest.guet.edu.cn"
);

const REGISTRY: &[SchoolSystemSpec] = &[GUET_PROD, GUET_TEST];

/// 正式域判定：抢课节奏的默认值、以及「压测档」的告警都要看它 ——
/// 测试域压出来的速率不能当作正式域的结论。
pub fn is_production_base(base_url: &str) -> bool {
    let b = base_url.trim().trim_end_matches('/').to_lowercase();
    b == GUET_PROD.default_base_url || (b.starts_with("https://bkjw.guet.edu.cn") && !b.contains("bkjwtest"))
}

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
        assert_eq!(list_info().len(), 2, "本科教务的正式域与测试域都要在册");
        let guet = spec("guet-supwisdom-eams5").expect("桂电必须在册");
        assert!(spec("nope").is_none());
        assert_eq!(guet.term.biz_type_id, 2);
        assert_eq!(list_info()[0].login_strategy, "supwisdom-portal-rsa");
        // 摘要入口只显示短名；短名必须是不带产品线后缀的可读校名
        assert_eq!(guet.short_name, "桂林电子科技大学");
        assert_eq!(list_info()[0].short_name, guet.short_name);
    }

    /// 两个域是同一套系统：**除域名与名字之外必须完全一致**。
    ///
    /// 这条断言防的是「改了一个域忘了另一个」—— 那种漂移只有到正式选课那天才会暴露，
    /// 而那天没法重来。
    #[test]
    fn the_two_guet_domains_never_drift_apart() {
        let prod = spec("guet-supwisdom-eams5").unwrap();
        let test = spec("guet-supwisdom-eams5-test").unwrap();

        assert_eq!(prod.default_base_url, "https://bkjw.guet.edu.cn", "默认必须是正式域");
        assert_eq!(test.default_base_url, "https://bkjwtest.guet.edu.cn");
        assert_eq!(list_info()[0].kind, "guet-supwisdom-eams5", "选择器第一项 = 默认 = 正式域");
        assert_eq!(list_info()[1].kind, "guet-supwisdom-eams5-test");

        assert_eq!(prod.term.biz_type_id, test.term.biz_type_id);
        assert_eq!(prod.term.week_start_on_sunday, test.term.week_start_on_sunday);
        assert_eq!(prod.login.id(), test.login.id());
        assert_eq!(prod.login.public_key(), test.login.public_key());
        assert_eq!(prod.endpoints.course_table_page, test.endpoints.course_table_page);
        assert_eq!(prod.endpoints.program_info, test.endpoints.program_info);

        // 两个域名都认得出来，且互不误判 —— 抢课节奏的默认值与压测告警都读它
        assert!(is_production_base("https://bkjw.guet.edu.cn"));
        assert!(is_production_base("https://bkjw.guet.edu.cn/"));
        assert!(!is_production_base("https://bkjwtest.guet.edu.cn"));
        assert!(!is_production_base("https://example.edu.cn"));
    }

    #[test]
    fn endpoint_templates_expand() {
        let e = GUET_PROD.endpoints;
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
