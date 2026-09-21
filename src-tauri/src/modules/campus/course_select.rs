//! 选课子系统（`/course-selection-api`）客户端。
//!
//! **它和课表不是同一套鉴权**，实测结论如下（每一条都打过真机）：
//!
//! 1. 选课系统自己的 `/login`（SHA1(salt + "-" + 密码)）对桂电账号**不可用** ——
//!    服务端返回「credentials did not match」。它的 `/evaluation/login-captcha/{token}`
//!    还要求另一套鉴权（401），也就是说 SPA 自带的登录页在本部署下本来就是坏的。
//! 2. 真正的入口是 **EAMS 门户发放的 SSO 令牌**：`GET /student/for-std/course-select`
//!    页面里写死了 `var url = 'https://<host>/course-selection/?token=<JWT>'`。
//!    JWT 载荷为 `{iss:"supwisdom", exp, username}`（HS256）。
//! 3. 拿到 JWT 后**直接当凭据用**即可：`Authorization: <JWT>`（裸 token，无 Bearer 前缀）。
//!    注意 SPA 路由守卫里的 `setStateToken` 也是直接把它塞进 store，并不调用
//!    `/evaluation/token-check`（那个接口同样 401，是死代码）。
//! 4. 响应信封统一为 `{result, message, data}`，且——**与其它接口相反**——
//!    `result` 为**假**才是成功（`result:0`），为真表示出错。这个反直觉的约定是本模块
//!    最容易写错的地方，所以只在 [`CourseSelectClient::call`] 一处判断。
//!
//! 因为令牌走的是已有的 EAMS 会话，**整条链路无需验证码、无需再输密码**，
//! 完全复用 `campus_accounts.cookies` 里那份登录态。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use crate::error::{ReinError, Result};

use super::http::{CookieJar, Session, SELECT_TIMEOUT};
use super::models::{AddItem, CourseSelectLesson, CourseSelectTurn, LessonQuery};

/// EAMS 门户里发放选课 SSO 令牌的页面
const TOKEN_PAGE: &str = "/student/for-std/course-select";
/// 页面里令牌出现的锚点（`var url = '.../course-selection/?token=xxx'`）
const TOKEN_MARKER: &str = "course-selection/?token=";
/// 接口前缀
const API: &str = "/course-selection-api/api/v1/student/course-select";

/// 令牌过期时错误信息里的固定前缀。
///
/// 抢课引擎据此把错误判成「**换张令牌就能接着干**」而不是「这个任务完了」——
/// 两者对一次连续抢课的差别是「续上」与「白排一晚上」。用常量而不是读错误类型，
/// 是因为错误要跨 module 边界走 `ReinError::Message`（见 [`CourseSelectClient::call`]）。
pub const TOKEN_EXPIRED: &str = "选课令牌已失效";

/// 从选课页面 HTML 里抠出 SSO 令牌。
///
/// 不用正则：项目没引 `regex` 依赖，而这里只需要「从锚点起吃到第一个非 token 字符」，
/// JWT 的字符集是 `[A-Za-z0-9_-]` 再加 `.` 分隔符。
fn extract_token(html: &str) -> Option<String> {
    let start = html.find(TOKEN_MARKER)? + TOKEN_MARKER.len();
    let rest = &html[start..];
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'))
        .unwrap_or(rest.len());
    let token = &rest[..end];
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// 读 JWT 的 `exp`（秒级时间戳）。解不出来就返回 None —— 调用方会退化成「每次重新获取」，
/// 属于安全侧的降级，不影响正确性。
fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let raw = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    v.get("exp").and_then(|e| e.as_i64())
}

/// 受理回执：服务端可能回字符串也可能回数字，统一成字符串。
///
/// 这两种情况我都见过（同一个网关下不同接口的 id 类型并不一致），所以不做类型假设。
fn request_id_of(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 选课请求体。**字段名逐字对齐 SPA 的构造代码**，所以抽成纯函数并加了单测 ——
/// 提交链路在本校当前无法真机验证（选课批次未开），这是唯一能钉住它的地方。
pub fn add_request_body(
    student_id: i64,
    turn_id: &str,
    items: Vec<AddItem>,
    course_pack: Option<serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!({
        "studentAssoc": student_id,
        "courseSelectTurnAssoc": turn_id,
        "requestMiddleDtos": items,
        "coursePackAssoc": course_pack,
    })
}

/// 占位请求体（`add-predicate`）。
///
/// 形状与 [`add_request_body`] **完全一致**，唯一区别是 `virtualCost` **恒为 0** ——
/// 占位不花意愿值，它只是「先在队列里占住一个位次」，随后再用 `add-request` 正式确认。
/// 所以这里不复制那份 json 字面量，而是改写 items 后复用同一个构造函数，
/// 免得日后 `add-request` 改了字段而占位悄悄跟不上。
pub fn predicate_body(
    student_id: i64,
    turn_id: &str,
    items: Vec<AddItem>,
    course_pack: Option<serde_json::Value>,
) -> serde_json::Value {
    let zeroed: Vec<AddItem> = items
        .into_iter()
        .map(|i| AddItem {
            virtual_cost: Some(0),
            ..i
        })
        .collect();
    add_request_body(student_id, turn_id, zeroed, course_pack)
}

/// 退课意向体（`drop-predicate`）。注意键名是 **`lessonAssocSet`**（集合），
/// 与正式退课的 `lessonAssocs` 不是同一个词 —— 这是从 SPA 两个不同的构造点抄下来的，
/// 改成「统一命名」就会 400。
pub fn drop_predicate_body(
    student_id: i64,
    turn_id: &str,
    lesson_ids: &[serde_json::Value],
) -> serde_json::Value {
    serde_json::json!({
        "studentAssoc": student_id,
        "courseSelectTurnAssoc": turn_id,
        "lessonAssocSet": lesson_ids,
    })
}

/// 正式退课体（`drop-request`）。
///
/// `confirm_midterm_retake` 是「期中重修」确认位：涉及时传 true，
/// 不涉及就让它整个消失（JS 的 undefined 语义），而不是发一个 `false` ——
/// 教务对未知键的容忍度未知，少发比多发安全。
pub fn drop_request_body(
    student_id: i64,
    turn_id: &str,
    lesson_ids: &[serde_json::Value],
    course_pack: Option<serde_json::Value>,
    confirm_midterm_retake: bool,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "studentAssoc": student_id,
        "courseSelectTurnAssoc": turn_id,
        "lessonAssocs": lesson_ids,
        "coursePackAssoc": course_pack,
    });
    if confirm_midterm_retake {
        body["confirmMidtermRetake"] = serde_json::Value::Bool(true);
    }
    body
}

/// 从 `query-lesson` / `simplest-lessons` 的 `data` 里取出教学班数组。
///
/// 两个接口都用 `data.lessons`，但也容忍 `data` 直接是数组 —— 没有真机非空样本，
/// 与其赌一种形状，不如两种都认。
fn lesson_list_of(v: &serde_json::Value) -> Vec<serde_json::Value> {
    v.get("lessons")
        .and_then(|l| l.as_array())
        .cloned()
        .or_else(|| v.as_array().cloned())
        .unwrap_or_default()
}

/// 教务的 id 有时是数字、有时是字符串（同一网关下不同接口并不一致），统一成文本。
fn scalar_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 选课会话。持有 SSO 令牌，负责把信封拆成裸数据。
pub struct CourseSelectClient {
    host: String,
    token: String,
}

/// 从 `turn-select` 的返回里取提交要用的批次 id。
///
/// **真实形状（2026-09-21 窗口开放后实测）**：批次 id 在**顶层** `turn.id`，
/// `{"turn":{"id":1921,"bizTypeAssoc":2,"semesterAssoc":321,…},"bizTypeId":2,…}` ——
/// `options` 这个键压根不存在。旧写法去找 `options.turn.id` 永远取不到，
/// 于是每次都退回列表 id；实测两者恰好相等（1921 = 1921），所以结果蒙对了 —— 但那是运气：
/// 一旦教务让两者分叉，我们就会拿着错的 id 去提交。
/// 现在按实测形状取值，`options.turn.id` 仅作兜底（历史写法，留着不亏）。
fn turn_id_of(v: &serde_json::Value) -> Option<String> {
    v.get("turn")
        .and_then(|t| t.get("id"))
        .or_else(|| {
            v.get("options")
                .and_then(|o| o.get("turn"))
                .and_then(|t| t.get("id"))
        })
        .and_then(scalar_text)
        .filter(|s| !s.is_empty())
}

impl CourseSelectClient {
    /// 用已有的 EAMS 会话去门户换一张选课令牌。
    ///
    /// 这一步不碰密码也不碰验证码 —— 只要 `cookies` 里的 EAMS 会话还有效就行。
    pub fn acquire(host: &str, jar: CookieJar) -> Result<Self> {
        let mut session = Session::new(host, jar);
        let resp = session.get(TOKEN_PAGE)?;
        if resp.is_redirect() {
            return Err(ReinError::Message(
                "教务会话已过期，无法获取选课令牌，请先在「课表配置」重新登录".into(),
            ));
        }
        if !resp.is_ok() {
            return Err(ReinError::Message(format!(
                "获取选课入口失败：HTTP {}",
                resp.status
            )));
        }
        let token = extract_token(&resp.text()).ok_or_else(|| {
            ReinError::Message("选课页面里没有找到 SSO 令牌，教务可能已改版".into())
        })?;
        Ok(Self {
            host: host.trim_end_matches('/').to_string(),
            token,
        })
    }

    /// 用已知令牌直接构造（走缓存时用，省掉一次门户往返）。
    pub fn with_token(host: &str, token: String) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// 用户在浏览器里打开它就是官方选课页 —— 出问题时让用户去那里核对最省事。
    pub fn entry_url(&self) -> String {
        format!("{}/course-selection/?token={}", self.host, self.token)
    }

    /// 这套会话打的是哪个域（正式 / 测试靠它区分，见 `provider::is_production_base`）。
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn expires_at(&self) -> Option<i64> {
        jwt_exp(&self.token)
    }

    /// 令牌是否还够用。留 5 分钟余量：抢课要连续轮询，卡在过期边界上会很难查。
    /// 目前只在真机联调测试（live_course_select_chain）里用作体检项。
    #[allow(dead_code)]
    pub fn is_fresh(&self) -> bool {
        match self.expires_at() {
            Some(exp) => exp - chrono::Utc::now().timestamp() > 300,
            // 解不出 exp 就当它有效，由服务端 401 兜底
            None => true,
        }
    }

    fn call(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let url = format!("{}{}", self.host, path);
        // 短超时（见 `http::SELECT_TIMEOUT`）：一次挂起会堵住单线程的抢课引擎
        let mut session = Session::with_timeout(&self.host, CookieJar::default(), SELECT_TIMEOUT);
        let auth = [("Authorization", self.token.as_str())];
        let resp = match body {
            Some(v) => session.request(
                method,
                &url,
                None,
                &auth,
                Some(("application/json", serde_json::to_vec(&v)?)),
            )?,
            None => session.request(method, &url, None, &auth, None)?,
        };

        if resp.status == 401 {
            return Err(ReinError::Message(format!(
                "{TOKEN_EXPIRED}，请重新打开选课页重试"
            )));
        }
        if !resp.is_ok() {
            return Err(ReinError::Message(format!("选课接口失败：HTTP {}", resp.status)));
        }

        let raw: serde_json::Value = resp
            .json()
            .map_err(|e| ReinError::Message(format!("选课接口返回非 JSON：{e}")))?;

        // ★ 反直觉：result 为真表示出错
        let failed = raw.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
        if failed {
            let msg = raw
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("选课接口返回了未知错误");
            return Err(ReinError::Message(msg.to_string()));
        }
        Ok(raw.get("data").cloned().unwrap_or(serde_json::Value::Null))
    }

    fn get(&self, path: &str) -> Result<serde_json::Value> {
        self.call("GET", path, None)
    }

    fn post(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        self.call("POST", path, Some(body))
    }

    /// 服务器时间。抢课的倒计时与对时全靠它，别用本机时钟。
    pub fn server_time(&self) -> Result<String> {
        let v = self.get(&format!("{API}/getCurrentDateTime"))?;
        Ok(v.as_str().unwrap_or_default().to_string())
    }

    /// 当前账号名下的学生（取 id 给后续接口用）。
    pub fn students(&self) -> Result<Vec<serde_json::Value>> {
        let v = self.get(&format!("{API}/multiple-students"))?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    /// 开放中的选课批次。**空数组是正常状态**（比如学期已开学），不是错误。
    ///
    /// 解析失败要**吵**不能静默丢：这是唯一一个我没能在真机上见到非空样本的接口
    /// （批次当前关闭），结构一旦对不上，宁可报「教务可能已改版」也不要给个空列表
    /// 让用户以为是「没批次」。
    pub fn open_turns(&self, student_id: i64) -> Result<Vec<CourseSelectTurn>> {
        let v = self.get(&format!("{API}/open-turns/{student_id}"))?;
        let arr = v.as_array().cloned().unwrap_or_default();
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            out.push(serde_json::from_value(item).map_err(|e| {
                ReinError::Message(format!("选课批次结构无法解析（教务可能已改版）：{e}"))
            })?);
        }
        Ok(out)
    }

    /// 查询教学班（查课/筛课）。
    ///
    /// 第二个参数是查询条件对象，**字段随 `query-condition/{turnId}` 渲染的表单而定**；
    /// 传 `LessonQuery::default()` 即「全部」。返回形状没有真机样本（批次当前关闭），
    /// 所以解析失败时把原始片段带在错误里 —— 等窗口开放时一眼就能看出是哪个字段对不上。
    pub fn query_lesson(
        &self,
        student_id: i64,
        turn_id: &str,
        query: &LessonQuery,
    ) -> Result<Vec<CourseSelectLesson>> {
        let body = serde_json::to_value(query)?;
        let v = self.post(&format!("{API}/query-lesson/{student_id}/{turn_id}"), body)?;
        parse_lessons(lesson_list_of(&v))
    }

    /// 快速抢课用的轻量课程列表（`data.lessons`）。
    ///
    /// **路径里只有 turnId，没有 studentId** —— 与同族的其它接口不同，别顺手补上。
    /// 它比 `query-lesson` 少一堆渲染字段，所以引擎拿它做「这课现在还有余量吗」的快速核对。
    pub fn simplest_lessons(&self, turn_id: &str) -> Result<Vec<CourseSelectLesson>> {
        let v = self.get(&format!("{API}/simplest-lessons/{turn_id}"))?;
        parse_lessons(lesson_list_of(&v))
    }

    /// 该批次的查询表单定义（有哪些可筛选字段、默认怎么排序）。
    ///
    /// 只读、纯展示用：拿到了就让界面照着渲染，拿不到（教务未提供 / 改版）就当没有，
    /// **绝不因为它失败而挡住查课**。
    pub fn query_condition(&self, turn_id: &str) -> Result<serde_json::Value> {
        self.get(&format!("{API}/query-condition/{turn_id}"))
    }

    /// 进批次：`{studentId}/turn/{turnId}/select`。
    ///
    /// 这一步**不是可选的仪式**。SPA 提交时发的 `courseSelectTurnAssoc` 是这里返回的
    /// `options.turn.id`，而不是 `open-turns` 列表里那个 id；`simplest-lessons` 也是拿它去调的。
    /// 我们手上没有真机样本可以确认两者是否相等（窗口没开），所以走
    /// [`Self::turn_assoc`]：能拿到就用拿到的，拿不到再退回列表 id。
    pub fn turn_select(&self, student_id: i64, turn_id: &str) -> Result<serde_json::Value> {
        self.get(&format!("{API}/{student_id}/turn/{turn_id}/select"))
    }

    /// 提交体里要用的批次 id（`courseSelectTurnAssoc`）。
    ///
    /// **绝不假定它与列表 id 相同**：取不到（接口失败 / 结构变了）就原样退回列表 id ——
    /// 那是我们唯一有把握的值。真实形状见 [`turn_id_of`]。
    pub fn turn_assoc(&self, student_id: i64, turn_id: &str) -> String {
        self.turn_select(student_id, turn_id)
            .ok()
            .and_then(|v| turn_id_of(&v))
            .unwrap_or_else(|| turn_id.to_string())
    }

    /// 我已选上的教学班名单（`selected-lessons/{turnId}/{studentId}`）。
    ///
    /// 这是「我到底选上没有」的正解 —— 比拉全量教学班再过滤准确，也便宜得多。
    /// 返回形状没有真机样本，所以只做「有没有命中我要的那个 id」的宽松匹配，
    /// 匹配逻辑交给出错概率更低的调用方（见 `grab::verify_picked`）。
    pub fn selected_lessons(
        &self,
        turn_id: &str,
        student_id: i64,
    ) -> Result<Vec<serde_json::Value>> {
        let v = self.get(&format!("{API}/selected-lessons/{turn_id}/{student_id}"))?;
        Ok(lesson_list_of(&v))
    }

    /* ---------------- 选课 ---------------- */

    /// 提交选课（`add-request`）。成功返回 `requestId`，**结果还要轮询**，见 [`Self::add_drop_response`]。
    pub fn add_request(
        &self,
        student_id: i64,
        turn_id: &str,
        items: Vec<AddItem>,
        course_pack: Option<serde_json::Value>,
    ) -> Result<String> {
        let body = add_request_body(student_id, turn_id, items, course_pack);
        let v = self.post(&format!("{API}/add-request"), body)?;
        Ok(request_id_of(&v))
    }

    /// 提交占位（`add-predicate`）。
    ///
    /// 抢课里它比 `add-request` 更早出手：开窗瞬间先占住队列位次（不花意愿值），
    /// 拿到 `requestId` 后用 [`Self::predicate_response`] 盯住它，落定后再正式确认。
    pub fn add_predicate(
        &self,
        student_id: i64,
        turn_id: &str,
        items: Vec<AddItem>,
        course_pack: Option<serde_json::Value>,
    ) -> Result<String> {
        let body = predicate_body(student_id, turn_id, items, course_pack);
        let v = self.post(&format!("{API}/add-predicate"), body)?;
        Ok(request_id_of(&v))
    }

    /// 轮询占位结果（`predicate-response`）。
    pub fn predicate_response(
        &self,
        student_id: i64,
        request_id: &str,
    ) -> Result<serde_json::Value> {
        self.get(&format!("{API}/predicate-response/{student_id}/{request_id}"))
    }

    /// 轮询选课/退课结果（`add-drop-response`）。SPA 每 2 秒一次、最多 10 次。
    pub fn add_drop_response(
        &self,
        student_id: i64,
        request_id: &str,
    ) -> Result<serde_json::Value> {
        self.get(&format!("{API}/add-drop-response/{student_id}/{request_id}"))
    }

    /// 退课意向（`drop-predicate`）：先登记「我想退」，拿 `requestId` 去 [`Self::predicate_response`] 盯。
    pub fn drop_predicate(
        &self,
        student_id: i64,
        turn_id: &str,
        lesson_ids: &[serde_json::Value],
    ) -> Result<String> {
        let body = drop_predicate_body(student_id, turn_id, lesson_ids);
        let v = self.post(&format!("{API}/drop-predicate"), body)?;
        Ok(request_id_of(&v))
    }

    /// 正式退课（`drop-request`）。结果同样走 [`Self::add_drop_response`] 轮询。
    pub fn drop_request(
        &self,
        student_id: i64,
        turn_id: &str,
        lesson_ids: &[serde_json::Value],
        course_pack: Option<serde_json::Value>,
        confirm_midterm_retake: bool,
    ) -> Result<String> {
        let body = drop_request_body(
            student_id,
            turn_id,
            lesson_ids,
            course_pack,
            confirm_midterm_retake,
        );
        let v = self.post(&format!("{API}/drop-request"), body)?;
        Ok(request_id_of(&v))
    }
}

/// 把一批原始 JSON 解析成教学班。单个坏元素不该拖垮整个列表 ——
/// 但要**吵**：把原始片段带进错误，窗口开放后第一次跑就能定位是哪个字段对不上。
fn parse_lessons(items: Vec<serde_json::Value>) -> Result<Vec<CourseSelectLesson>> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let raw = item.to_string();
        out.push(serde_json::from_value(item).map_err(|e| {
            ReinError::Message(format!(
                "教学班结构无法解析（教务可能已改版）：{e}；原始片段：{}",
                &raw[..raw.len().min(400)]
            ))
        })?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_token_from_page() {
        // 逐字照抄线上页面片段
        let html = r#"<script>
        var url = 'https://bkjwtest.guet.edu.cn/course-selection/?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXB3aXNkb20ifQ.abc-DEF_123';
        window.location.href = url;
        </script>"#;
        assert_eq!(
            extract_token(html).unwrap(),
            "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXB3aXNkb20ifQ.abc-DEF_123"
        );
    }

    #[test]
    fn token_extraction_rejects_garbage() {
        assert!(extract_token("<html>没有令牌</html>").is_none());
        assert!(extract_token("course-selection/?token=").is_none());
        // 令牌后紧跟引号，必须停在引号前（页面里正是 `'...token=xxx'` 这种写法）
        let h = r#"course-selection/?token=aaa.bbb-ccc_111' + more"#;
        assert_eq!(extract_token(h).unwrap(), "aaa.bbb-ccc_111");
    }

    #[test]
    fn reads_jwt_expiry() {
        // {"iss":"supwisdom","exp":1789642821,"username":"2600350118"}
        let t = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.\
                 eyJpc3MiOiJzdXB3aXNkb20iLCJleHAiOjE3ODk2NDI4MjEsInVzZXJuYW1lIjoiMjYwMDM1MDExOCJ9.\
                 fNAMrVsGzeh04T5a4iI6aPZWEpvrawY_hlaVcL4yCKU";
        assert_eq!(jwt_exp(t), Some(1789642821));
        assert_eq!(jwt_exp("not-a-jwt"), None);
        assert_eq!(jwt_exp("a.!!!invalid!!!.c"), None);
    }

    #[test]
    fn freshness_uses_expiry_with_margin() {
        let future = chrono::Utc::now().timestamp() + 3600;
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{future}}}"#));
        let c = CourseSelectClient {
            host: "https://x".into(),
            token: format!("h.{payload}.s"),
        };
        assert!(c.is_fresh());

        let soon = chrono::Utc::now().timestamp() + 60;
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{soon}}}"#));
        let c = CourseSelectClient {
            host: "https://x".into(),
            token: format!("h.{payload}.s"),
        };
        assert!(!c.is_fresh(), "5 分钟内到期的令牌应当被判定为不新鲜");
    }

    #[test]
    fn envelope_treats_result_true_as_error() {
        // 这个约定与其余接口相反，用测试把它钉死
        let body = serde_json::json!({"result": true, "message": "选课已结束", "data": null});
        let failed = body.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
        assert!(failed, "result=true 必须判为失败");

        let ok = serde_json::json!({"result": 0, "message": null, "data": "2026-09-17 07:00:46"});
        assert!(!ok.get("result").and_then(|v| v.as_bool()).unwrap_or(false));
    }

    /// 提交链路在本校当前无法真机验证（选课批次未开），所以把请求体形状逐字钉死 ——
    /// 这些键名是从 SPA 的构造代码里抄出来的，改错了抢课就会静默失败。
    #[test]
    fn add_request_body_matches_spa_shape() {
        let body = add_request_body(
            241250,
            "77",
            vec![AddItem {
                lesson_assoc: serde_json::json!(317844),
                virtual_cost: None,
                schedule_group_assoc: None,
                need_attend: None,
            }],
            None,
        );
        assert_eq!(body["studentAssoc"], 241250);
        assert_eq!(body["courseSelectTurnAssoc"], "77");
        assert!(body["coursePackAssoc"].is_null());
        let dto = &body["requestMiddleDtos"][0];
        assert_eq!(dto["lessonAssoc"], 317844);
        // SPA 里 virtualCost 总是存在（未启用虚拟钱包时为 null），不能被省掉
        assert!(dto.as_object().unwrap().contains_key("virtualCost"));
        assert!(dto["virtualCost"].is_null());
        // 未选上课小组时该键应当整个消失（JS 的 undefined 语义）
        assert!(!dto.as_object().unwrap().contains_key("scheduleGroupAssoc"));
        assert!(!dto.as_object().unwrap().contains_key("needAttend"));
    }

    #[test]
    fn add_request_body_carries_wallet_and_group_when_present() {
        let body = add_request_body(
            241250,
            "77",
            vec![AddItem {
                lesson_assoc: serde_json::json!(5),
                virtual_cost: Some(30),
                schedule_group_assoc: Some(serde_json::json!(9)),
                need_attend: Some(true),
            }],
            Some(serde_json::json!(1234)),
        );
        let dto = &body["requestMiddleDtos"][0];
        assert_eq!(dto["virtualCost"], 30);
        assert_eq!(dto["scheduleGroupAssoc"], 9);
        assert_eq!(dto["needAttend"], true);
        assert_eq!(body["coursePackAssoc"], 1234);
    }

    #[test]
    fn drop_body_uses_lesson_assoc_set() {
        // `drop-predicate` 与 `drop-request` 用的是**两个不同的键名**，
        // 这是从 SPA 两处独立的构造代码抄下来的，谁都别想「统一」它们。
        let intend = drop_predicate_body(241250, "77", &[serde_json::json!(1), serde_json::json!(2)]);
        assert_eq!(intend["studentAssoc"], 241250);
        assert_eq!(intend["courseSelectTurnAssoc"], "77");
        assert_eq!(intend["lessonAssocSet"], serde_json::json!([1, 2]));
        assert!(
            !intend.as_object().unwrap().contains_key("lessonAssocs"),
            "意向用 lessonAssocSet"
        );

        let formal = drop_request_body(241250, "77", &[serde_json::json!(9999)], None, true);
        assert_eq!(formal["lessonAssocs"], serde_json::json!([9999]));
        assert!(
            !formal.as_object().unwrap().contains_key("lessonAssocSet"),
            "正式退课用 lessonAssocs"
        );
        assert_eq!(formal["confirmMidtermRetake"], true);
        assert!(formal["coursePackAssoc"].is_null());
    }

    #[test]
    fn drop_request_omits_midterm_flag_when_not_needed() {
        // 不涉及期中重修时该键应当整个消失（JS undefined 语义），而不是发一个 false
        let body = drop_request_body(1, "2", &[serde_json::json!(3)], None, false);
        assert!(!body.as_object().unwrap().contains_key("confirmMidtermRetake"));
    }

    /// 占位是抢课的第一步，它的形状必须与正式提交**只差 virtualCost**。
    #[test]
    fn predicate_body_zeroes_virtual_cost_and_keeps_the_rest() {
        let items = vec![AddItem {
            lesson_assoc: serde_json::json!(317844),
            // 用户可能填了意愿值，占位阶段必须被压成 0
            virtual_cost: Some(60),
            schedule_group_assoc: Some(serde_json::json!(9)),
            need_attend: None,
        }];
        let body = predicate_body(241250, "77", items.clone(), Some(serde_json::json!(1234)));
        let formal = add_request_body(241250, "77", items, Some(serde_json::json!(1234)));

        assert_eq!(body["requestMiddleDtos"][0]["virtualCost"], 0);
        assert_eq!(formal["requestMiddleDtos"][0]["virtualCost"], 60);
        // 除 virtualCost 外逐键相同
        let mut a = body.clone();
        let mut b = formal;
        a["requestMiddleDtos"][0]["virtualCost"] = serde_json::json!("*");
        b["requestMiddleDtos"][0]["virtualCost"] = serde_json::json!("*");
        assert_eq!(a, b, "占位与正式提交只应差 virtualCost");
        // 上课小组照常带上：占位占的是**那一个组**的位次
        assert_eq!(body["requestMiddleDtos"][0]["scheduleGroupAssoc"], 9);
        assert_eq!(body["coursePackAssoc"], 1234);
    }

    #[test]
    fn lesson_query_skips_empty_fields() {
        // 教务对多余键的容忍度未知，少发比多发安全
        let body = serde_json::to_value(LessonQuery::default()).unwrap();
        assert_eq!(body, serde_json::json!({}));

        // UI 搜索框发出的就是这三个键 —— 名字对齐教务，写错会被当成「没有条件」静默返回全量
        let searching = LessonQuery {
            lesson_name_or_code: Some("高数".into()),
            sort_field: Some("lessonAssoc".into()),
            sort_type: Some("ASC".into()),
            ..Default::default()
        };
        let body = serde_json::to_value(searching).unwrap();
        assert_eq!(body["lessonNameOrCode"], "高数");
        assert_eq!(body["sortField"], "lessonAssoc");
        assert_eq!(body["sortType"], "ASC");
        assert!(!body.as_object().unwrap().contains_key("courseCode"));
        assert!(!body.as_object().unwrap().contains_key("hasCount"));
        assert_eq!(body.as_object().unwrap().len(), 3);
    }

    #[test]
    fn lesson_list_reads_both_envelope_shapes() {
        // 有真机样本的只有 `data.lessons`；`data` 直接是数组也认，免得赌错一种就空列表
        let with_lessons = serde_json::json!({"lessons": [{"id": 1}], "total": 1});
        assert_eq!(lesson_list_of(&with_lessons).len(), 1);
        let bare = serde_json::json!([{"id": 1}, {"id": 2}]);
        assert_eq!(lesson_list_of(&bare).len(), 2);
        assert!(lesson_list_of(&serde_json::Value::Null).is_empty());
    }

    /// 教务的 id 一会儿是数字一会儿是字符串，统一成文本才能比对。
    #[test]
    fn scalar_text_normalises_ids_and_rejects_the_rest() {
        assert_eq!(scalar_text(&serde_json::json!(317844)).as_deref(), Some("317844"));
        assert_eq!(scalar_text(&serde_json::json!("65535")).as_deref(), Some("65535"));
        assert_eq!(scalar_text(&serde_json::json!(null)), None);
        assert_eq!(scalar_text(&serde_json::json!({})), None);
        assert_eq!(scalar_text(&serde_json::json!([1])), None);
    }

    #[test]
    fn turn_opens_at_prefers_structured_range() {
        let turn: CourseSelectTurn = serde_json::from_value(serde_json::json!({
            "id": 77,
            "selectDateTimeText": "2026-09-17 08:00 ~ 23:59",
            "selectDateTimeRange": {"startDateTime": "2026-09-17 08:00:00", "endDateTime": "2026-09-17 23:59:59"}
        }))
        .unwrap();
        assert_eq!(turn.opens_at_text().as_deref(), Some("2026-09-17 08:00:00"));

        // 没有结构化区间时退化成从文本里抠出波浪线前那一段
        let text_only: CourseSelectTurn = serde_json::from_value(serde_json::json!({
            "id": 77,
            "selectDateTimeText": "2026-09-17 08:00 ~ 23:59"
        }))
        .unwrap();
        assert_eq!(text_only.opens_at_text().as_deref(), Some("2026-09-17 08:00"));

        let none: CourseSelectTurn =
            serde_json::from_value(serde_json::json!({"id": 77})).unwrap();
        assert_eq!(none.opens_at_text(), None);
    }

    #[test]
    fn request_id_normalises_scalar_types() {
        assert_eq!(request_id_of(&serde_json::json!("abc")), "abc");
        assert_eq!(request_id_of(&serde_json::json!(42)), "42");
        assert_eq!(request_id_of(&serde_json::json!(null)), "");
    }

    /// `turn-select` 的真实形状：批次 id 在**顶层** `turn.id`（2026-09-21 窗口开放后逐字抄下来）。
    /// 这条断言钉住的是「别再回去找 `options.turn.id`」—— 那键压根不存在，旧写法每次都退回
    /// 列表 id，只是这次两者恰好相等（1921 = 1921）才没出事。
    #[test]
    fn turn_select_reads_the_top_level_turn_id() {
        let real = serde_json::json!({
            "packCourseSelect": false,
            "turn": {"id": 1921, "bizTypeAssoc": 2, "semesterAssoc": 321, "name": "2026-2027学年第一学期新生选课"},
            "bizTypeId": 2,
            "semester": {"id": 321, "nameZh": "2026-2027上学期", "season": "AUTUMN"},
            "campusId": 3
        });
        assert_eq!(turn_id_of(&real).as_deref(), Some("1921"));

        // 老形状（`options.turn.id`）仍然认得，免得哪个部署还留着它
        let legacy = serde_json::json!({"options": {"turn": {"id": "77"}}});
        assert_eq!(turn_id_of(&legacy).as_deref(), Some("77"));

        // 两个都在时，顶层优先
        let both = serde_json::json!({"turn": {"id": 1}, "options": {"turn": {"id": 2}}});
        assert_eq!(turn_id_of(&both).as_deref(), Some("1"));

        // 空值/坏形状一律 None，让调用方退回列表 id
        assert_eq!(turn_id_of(&serde_json::json!({"turn": {"id": null}})), None);
        assert_eq!(turn_id_of(&serde_json::json!({"turn": {}})), None);
        assert_eq!(turn_id_of(&serde_json::json!({})), None);
    }

    #[test]
    fn lesson_parses_from_best_effort_shape() {
        // 从 SPA 表格渲染代码逆推出的形状
        let raw = serde_json::json!({
            "id": 317844,
            "course": {"id": 26074, "code": "000003", "nameZh": "大学生心理健康教育", "credits": 2},
            "selectedLesson": null,
            "stdCount": 110,
            "limitCount": 110,
            "scheduleGroups": [{"id": 9, "no": 1, "default": true, "limitCount": 60}]
        });
        let l: CourseSelectLesson = serde_json::from_value(raw).unwrap();
        assert_eq!(l.id, serde_json::json!(317844));
        assert_eq!(l.course.unwrap().name_zh.as_deref(), Some("大学生心理健康教育"));
        assert!(l.selected_lesson.is_none());
        assert_eq!(l.schedule_groups[0].limit_count, Some(60));
    }

    #[test]
    fn lesson_tolerates_missing_fields() {
        // 教务少给字段时不能整列表挂掉 —— 真正提交只用得上 id
        let l: CourseSelectLesson = serde_json::from_value(serde_json::json!({"id": 1})).unwrap();
        assert_eq!(l.id, serde_json::json!(1));
        assert!(l.course.is_none());
        assert!(l.teachers.is_empty());
    }

    /// 真机联调（默认忽略）：验证「EAMS 会话 → 选课 SSO 令牌 → 选课接口」这条链路。
    ///
    /// 这是选课功能里**唯一能在当前验证的一段**（选课批次未开放，教学班与提交没法跑），
    /// 也恰恰是最难的部分 —— 选课系统自带的登录对桂电账号是坏的，
    /// 令牌只能从门户页面里刮。教务改版时它会第一个红。
    ///
    /// ```text
    /// $env:REIN_GUET_USER='2600xxxxxx'; $env:REIN_GUET_PASS='...'
    /// cargo test --lib campus::course_select::tests::live -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "打真实教务系统，需要 REIN_GUET_USER / REIN_GUET_PASS"]
    fn live_course_select_chain() {
        use crate::modules::campus::guet::GuetAdapter;

        let (Ok(user), Ok(pass)) = (
            std::env::var("REIN_GUET_USER"),
            std::env::var("REIN_GUET_PASS"),
        ) else {
            println!("缺少 REIN_GUET_USER / REIN_GUET_PASS，跳过");
            return;
        };
        let spec = crate::modules::campus::provider::spec("guet-supwisdom-eams5").unwrap();
        let host = spec.default_base_url;

        // ① 先拿 EAMS 会话（复用课表那套登录）
        let mut session = Session::new(host, CookieJar::default());
        {
            let mut adapter = GuetAdapter::new(spec, &mut session);
            let outcome = adapter.login(&user, &pass, "").expect("登录请求要能发出");
            assert!(outcome.ok, "EAMS 登录被拒：{:?}", outcome.message);
        }
        let jar = session.jar().clone();
        println!("✓ EAMS 会话就绪");

        // ② 用会话换选课 SSO 令牌
        let client = CourseSelectClient::acquire(host, jar).expect("换取选课令牌");
        println!(
            "✓ 选课令牌 len={} exp={:?} fresh={}",
            client.token().len(),
            client.expires_at(),
            client.is_fresh()
        );

        // ③ 令牌生效：服务器时间 + 学生档案
        let t = client.server_time().expect("取服务器时间");
        assert!(!t.is_empty(), "服务器时间不能为空");
        println!("✓ 服务器时间：{t}");

        let students = client.students().expect("取学生档案");
        let me = students.first().expect("至少要有一个学生");
        let sid = me.get("id").and_then(|v| v.as_i64()).expect("学生 id");
        let code = me.get("code").and_then(|v| v.as_str()).unwrap_or("?");
        println!("✓ 学生：{code} (id={sid})");
        assert_eq!(code, user, "选课系统返回的学号与登录账号不一致");

        // ④ 批次列表：为空是正常状态（比如大一还没轮到选课窗口），不是失败
        let turns = client.open_turns(sid).expect("取开放批次");
        println!(
            "✓ 开放批次 {} 个{}",
            turns.len(),
            if turns.is_empty() { "（当前没有选课窗口，属正常）" } else { "" }
        );
        println!("✓ 选课链路联调通过");
    }
}
