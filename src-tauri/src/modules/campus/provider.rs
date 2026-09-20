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
    /// **全校开课查询**入口页。它是独立的菜单项（`for-std-lesson-search:menu`），
    /// 与选课批次无关 —— 批次没开的时候照样能查全校开了哪些课。
    pub lesson_search_page: &'static str,
    /// 开课查询页面（带学生标识，路径里的数字就是 `studentId`）
    pub lesson_search_index: &'static str,
    /// 开课查询的数据接口：`/semester/{sem}/search/{std}`，返回分页的开课列表
    pub lesson_search_data: &'static str,
}

/// 开课查询数据接口里那些**逐字对齐教务**的固定参数。
///
/// `bizTypeAssoc=2` = 本科；`assembleFields` 要哪些附加列（少了它行里就没有
/// 开课院系 / 教师 / 时间地点这些列）。这两个值来自实测抓包，不要凭直觉改。
const LESSON_SEARCH_ASSEMBLE_FIELDS: &str = "course.code,minorCourse.nameZh,courseType,openDepartment,teacherAssignmentList,examMode,campus,teachLang,roomType,timeTableLayout,crossBizTypes,courseProperty";

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

    /// `/student/for-std/lesson-search?bizTypeId=2`
    pub fn lesson_search_page_for(&self, biz_type_id: i64) -> String {
        format!("{}?bizTypeId={biz_type_id}", self.lesson_search_page)
    }

    /// `/student/for-std/lesson-search/index/241250`
    pub fn lesson_search_index_for(&self, student_id: &str) -> String {
        self.lesson_search_index.replace("{std}", student_id)
    }

    /// `/student/for-std/lesson-search/semester/321/search/241250?bizTypeAssoc=2&queryPage__=1,20&assembleFields=…`
    ///
    /// `queryPage__` 的写法是教务自己的约定（两个下划线，逗号分隔 `页码,每页条数`），
    /// 不是标准的 `page`/`size` —— 写错会被当成无参请求，静默返回第一页。
    pub fn lesson_search_data_for(
        &self,
        semester_id: i64,
        student_id: &str,
        biz_type_id: i64,
        page: i64,
        page_size: i64,
    ) -> String {
        let path = self
            .lesson_search_data
            .replace("{sem}", &semester_id.to_string())
            .replace("{std}", student_id);
        format!(
            "{path}?bizTypeAssoc={biz_type_id}&queryPage__={page},{page_size}&assembleFields={LESSON_SEARCH_ASSEMBLE_FIELDS}"
        )
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
/// **本科教务有两个域名，但它们不是同一套系统**（2026-09 实测，逐路径比对）：
///
/// - `bkjwtest.guet.edu.cn` —— **树维 Supwisdom EAMS5**，也就是本文件声明并打通的那一套。
///   `/student/home` 302 到登录页、`/student/static/eams-ui/js/eams-ui.js` 200、
///   `/student/ldap/login-salt` 200 —— 握手与接口表全部对得上。
/// - `bkjw.guet.edu.cn` —— **另一套系统**：ASP.NET MVC + ExtJS 桌面（`Edu.view.*`、
///   `/?ticket=srv`），登录走统一身份认证 CAS（`cas.guet.edu.cn/cas/login?service=…`）。
///   它的 `/student/**` **全部 404**（连静态资源 `eams-ui.js` 也是 404，说明 EAMS5
///   根本没部署在这个域名上）。
///
/// 所以**不能**把 bkjw 声明成同一套 EAMS5 再设成默认：那样用户一登录就撞 404。
/// 这里只声明确实存在的那一套，默认域用能跑通的这个；bkjw 作为**候选域名**参与
/// [`GUET_DOMAINS`] 的探测（见 [`probe_hint`]），而不是被当成同构的第二个实例。
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
                lesson_search_page: "/student/for-std/lesson-search",
                lesson_search_index: "/student/for-std/lesson-search/index/{std}",
                lesson_search_data: "/student/for-std/lesson-search/semester/{sem}/search/{std}",
            },
            term: TermSpec {
                biz_type_id: 2,
                week_start_on_sunday: false,
            },
        }
    };
}

const GUET: SchoolSystemSpec = guet_spec!(
    "guet-supwisdom-eams5",
    "桂林电子科技大学 · 本科生教学信息平台",
    "树维 Supwisdom EAMS5 · 学生端 · bkjwtest.guet.edu.cn",
    "https://bkjwtest.guet.edu.cn"
);

const REGISTRY: &[SchoolSystemSpec] = &[GUET];

/// 本科教务的**候选域名**，供「两个域都检测」用。
///
/// 顺序即探测顺序：正式域在前（真在用的那套），EAMS5 部署在后。
/// 注意二者**不是同一套系统**（见文件头），所以探测结果要按域名分别汇报，
/// 不能互相兜底：一个域没有的接口，去另一个域也找不到。
pub const GUET_DOMAINS: [&str; 2] = ["https://bkjw.guet.edu.cn", "https://bkjwtest.guet.edu.cn"];

/// 规范化域名：去空白、去尾斜杠、转小写。
pub fn normalize_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_lowercase()
}

/// 抢课速率是在哪个域上标定的：`bkjwtest` 的风控比正式域松，
/// 拿它压出来的数字去正式域打，结论不成立 —— 设置页据此给出告警。
///
/// 判定的是「**不是**测试域」而不是「等于某个常量」：用户完全可能填一个
/// 反向代理域名，那种情况同样不该被当成测试域。
pub fn is_production_base(base_url: &str) -> bool {
    let b = normalize_base(base_url);
    !b.contains("bkjwtest")
}

/// 候选域名的**静态**提示：这条路是 EAMS5，那条路不是。
///
/// 只用于界面说明与探测排序 —— 真伪仍以运行时探测为准（[`super::lesson_search`]）。
pub fn probe_hint(base_url: &str) -> &'static str {
    if normalize_base(base_url).contains("bkjwtest") {
        "树维 EAMS5（本应用打通的那一套）"
    } else {
        "另一套系统（ASP.NET + ExtJS 桌面，登录走 CAS）"
    }
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
        // 在册的只有**真跑得通的那一套**（EAMS5）。bkjw 是另一套系统，
        // 不能当同构实例混进来 —— 它由 GUET_DOMAINS 参与探测，不在 REGISTRY 里。
        assert_eq!(list_info().len(), 1, "只有打通的那一套 EAMS5 在册");
        let guet = spec("guet-supwisdom-eams5").expect("桂电必须在册");
        assert!(spec("nope").is_none());
        assert_eq!(guet.term.biz_type_id, 2);
        assert_eq!(list_info()[0].login_strategy, "supwisdom-portal-rsa");
        // 摘要入口只显示短名；短名必须是不带产品线后缀的可读校名
        assert_eq!(guet.short_name, "桂林电子科技大学");
        assert_eq!(list_info()[0].short_name, guet.short_name);
    }

    /// **默认域必须是真跑得通的那一个**。
    ///
    /// 这条断言防的是一类很贵的错：把「本科教务的正式域名」按名字想当然地当成
    /// EAMS5 的部署地址。实测 `bkjw.guet.edu.cn` 是另一套系统（ASP.NET + ExtJS 桌面，
    /// 登录走 CAS），它的 `/student/**` 全部 404 —— 一旦把它设成默认，
    /// 新装用户填完学号密码就直接撞 404。
    #[test]
    fn the_default_domain_is_the_one_that_actually_serves_eams5() {
        let guet = spec("guet-supwisdom-eams5").unwrap();
        assert_eq!(
            guet.default_base_url, "https://bkjwtest.guet.edu.cn",
            "默认域必须是实测能跑通 EAMS5 握手的那一个"
        );
        assert_eq!(list_info()[0].kind, "guet-supwisdom-eams5");
        assert_eq!(list_info()[0].default_base_url, guet.default_base_url);
    }

    /// 两个候选域名都要能被探测，且顺序稳定（正式域在前）。
    #[test]
    fn both_candidate_domains_are_probeable() {
        assert_eq!(GUET_DOMAINS.len(), 2);
        assert_eq!(GUET_DOMAINS[0], "https://bkjw.guet.edu.cn");
        assert_eq!(GUET_DOMAINS[1], "https://bkjwtest.guet.edu.cn");
        assert!(probe_hint(GUET_DOMAINS[0]).contains("另一套系统"));
        assert!(probe_hint(GUET_DOMAINS[1]).contains("EAMS5"));
    }

    /// 域名规范化：带尾斜杠 / 大小写 / 空白都必须归一到同一个判定。
    #[test]
    fn base_normalisation_is_forgiving() {
        assert_eq!(
            normalize_base("  HTTPS://BkjwTest.GUET.edu.cn/  "),
            "https://bkjwtest.guet.edu.cn"
        );
        assert_eq!(
            normalize_base("https://bkjwtest.guet.edu.cn"),
            "https://bkjwtest.guet.edu.cn"
        );
    }

    /// 抢课速率告警的判定：**测试域不算生产**，其余（含自建反代）都按生产对待。
    #[test]
    fn production_flag_only_excludes_the_test_domain() {
        assert!(!is_production_base("https://bkjwtest.guet.edu.cn"));
        assert!(!is_production_base("https://bkjwtest.guet.edu.cn/"));
        assert!(is_production_base("https://bkjw.guet.edu.cn"));
        assert!(is_production_base("https://example.edu.cn"));
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
